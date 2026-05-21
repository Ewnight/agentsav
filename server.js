const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── Charge les boutiques depuis les variables d'environnement ──
// Format attendu : SHOP_KEY_<identifiant>=domaine.myshopify.com|shpat_xxxxx|email@gerant.com
function loadShops() {
  const shops = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('SHOP_KEY_')) {
      const apiKey = key.replace('SHOP_KEY_', '').toLowerCase();
      const [shopDomain, shopToken, ownerEmail] = value.split('|');
      if (shopDomain && shopToken) {
        shops[apiKey] = {
          shopDomain: shopDomain.trim(),
          shopToken: shopToken.trim(),
          ownerEmail: ownerEmail ? ownerEmail.trim() : null
        };
      }
    }
  }
  return shops;
}

const SHOPS = loadShops();
console.log(`${Object.keys(SHOPS).length} boutique(s) chargée(s)`);

// ── Cherche une commande Shopify par numéro ou email ──
async function findShopifyOrder(query, shopDomain, accessToken) {
  try {
    const orderNumber = query.match(/#?(\d{3,6})/)?.[1];
    const email = query.match(/[\w.-]+@[\w.-]+\.\w+/)?.[0];

    let url;
    if (orderNumber) {
      url = `https://${shopDomain}/admin/api/2024-01/orders.json?name=%23${orderNumber}&status=any`;
    } else if (email) {
      url = `https://${shopDomain}/admin/api/2024-01/orders.json?email=${email}&status=any&limit=1`;
    } else {
      return null;
    }

    const response = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    const order = data.orders?.[0];
    if (!order) return null;

    return {
      numero: order.name,
      statut: order.fulfillment_status === 'fulfilled' ? 'Expédiée' :
              order.fulfillment_status === 'partial' ? 'Partiellement expédiée' :
              order.financial_status === 'paid' ? 'Payée — en préparation' : 'En attente',
      total: `${order.total_price} ${order.currency}`,
      date: new Date(order.created_at).toLocaleDateString('fr-FR'),
      tracking: order.fulfillments?.[0]?.tracking_number || null,
      transporteur: order.fulfillments?.[0]?.tracking_company || null,
      tracking_url: order.fulfillments?.[0]?.tracking_url || null,
      articles: order.line_items?.map(i => `${i.quantity}x ${i.name}`).join(', ')
    };
  } catch (err) {
    console.error('Shopify error:', err.message);
    return null;
  }
}

// ── Envoi email d'escalade via Resend ──
async function sendEscaladeEmail({ ownerEmail, customerEmail, shopName, agentName, conversation }) {
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY manquante');
    return false;
  }

  const conversationHtml = conversation
    .map(m => `<p><strong>${m.role === 'user' ? '👤 Client' : '🤖 ' + agentName}</strong> : ${m.content}</p>`)
    .join('');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'NightAgent <onboarding@resend.dev>',
      to: ownerEmail,
      subject: `[${shopName}] Demande client non résolue — intervention requise`,
      html: `
        <h2>Un client a besoin de votre aide</h2>
        <p>Votre assistant <strong>${agentName}</strong> n'a pas pu résoudre la demande du client.</p>
        ${customerEmail ? `<p><strong>Email du client :</strong> <a href="mailto:${customerEmail}">${customerEmail}</a></p>` : ''}
        <hr/>
        <h3>Récapitulatif de la conversation</h3>
        ${conversationHtml}
        <hr/>
        <p style="color:#888;font-size:12px;">NightAgent — support automatisé</p>
      `
    })
  });

  return response.ok;
}

// ── Route principale chat ──
app.post('/chat', async (req, res) => {
  const { messages, system, apiKey } = req.body;

  if (!messages || !system) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  // Résolution des credentials Shopify via la clé API (jamais exposés au client)
  const shop = apiKey ? SHOPS[apiKey.toLowerCase()] : null;

  // Cherche une commande si le dernier message en mentionne une
  const lastMessage = messages[messages.length - 1]?.content || '';
  const orderMentioned = /commande|order|#\d{3,}|\d{4,}|suivi|livraison|où est/i.test(lastMessage);

  let orderContext = '';
  if (orderMentioned && shop) {
    const order = await findShopifyOrder(lastMessage, shop.shopDomain, shop.shopToken);
    if (order) {
      orderContext = `\n\n[DONNÉES COMMANDE RÉELLES]\nNuméro: ${order.numero}\nStatut: ${order.statut}\nDate: ${order.date}\nArticles: ${order.articles}\nTotal: ${order.total}${order.tracking ? `\nNuméro de suivi: ${order.tracking} (${order.transporteur})` : ''}\nUtilise ces informations pour répondre avec précision.`;
    }
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: system + orderContext,
        messages
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    res.json({ reply: data.content?.[0]?.text || "Désolée, une erreur s'est produite." });

  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── Route escalade : envoi email au gérant quand le bot ne peut pas résoudre ──
app.post('/escalade', async (req, res) => {
  const { apiKey, shopName, agentName, customerEmail, conversation } = req.body;

  if (!apiKey || !conversation) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  const shop = SHOPS[apiKey.toLowerCase()];
  if (!shop || !shop.ownerEmail) {
    return res.status(404).json({ error: 'Boutique introuvable ou email gérant non configuré' });
  }

  try {
    const sent = await sendEscaladeEmail({
      ownerEmail: shop.ownerEmail,
      customerEmail,
      shopName,
      agentName,
      conversation
    });

    if (sent) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: "Échec de l'envoi email" });
    }
  } catch (err) {
    console.error('Escalade error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── Route inscription : reçoit les demandes d'essai depuis la landing page ──
app.post('/inscription', async (req, res) => {
  const { name, email, domain, plan } = req.body;

  if (!name || !email || !domain || !plan) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  const notifEmail = process.env.NOTIF_EMAIL || 'contact@nightagent.fr';

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'NightAgent <onboarding@resend.dev>',
        to: notifEmail,
        subject: `[NightAgent] Nouvelle inscription — ${plan} — ${domain}`,
        html: `
          <h2>🎉 Nouvelle demande d'essai NightAgent</h2>
          <table style="border-collapse:collapse;width:100%;max-width:480px;">
            <tr><td style="padding:8px 0;color:#888;font-size:13px;">Plan</td><td style="padding:8px 0;font-weight:700;">${plan}</td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:13px;">Nom</td><td style="padding:8px 0;">${name}</td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:13px;">Email</td><td style="padding:8px 0;"><a href="mailto:${email}">${email}</a></td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:13px;">Domaine Shopify</td><td style="padding:8px 0;">${domain}</td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:13px;">Date</td><td style="padding:8px 0;">${new Date().toLocaleString('fr-FR')}</td></tr>
          </table>
          <hr style="margin:1.5rem 0;border:none;border-top:1px solid #eee;"/>
          <p style="color:#888;font-size:12px;">À faire : créer la clé Render + envoyer le snippet à ${email}</p>
        `
      })
    });

    if (!response.ok) {
      const err = await response.json();
      console.error('Resend error:', err);
      return res.status(500).json({ error: 'Erreur envoi email' });
    }

    console.log(`Nouvelle inscription : ${name} — ${email} — ${domain} — ${plan}`);
    res.json({ success: true });

  } catch (err) {
    console.error('Inscription error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/', (req, res) => res.send('Agent SAV OK ✓'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur SAV lancé sur le port ${PORT}`));
