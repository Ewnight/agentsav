const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── Rate limiting en mémoire ──
// Par IP : 20 req/min (protection bots/spam)
// Par clé API : 60 req/min (protection facture Anthropic)
const rateLimitStore = {};

function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  if (!rateLimitStore[key]) {
    rateLimitStore[key] = { count: 1, resetAt: now + windowMs };
    return true;
  }
  const entry = rateLimitStore[key];
  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + windowMs;
    return true;
  }
  if (entry.count >= maxRequests) return false;
  entry.count++;
  return true;
}

// Nettoyage toutes les 5 minutes pour éviter les fuites mémoire
setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(rateLimitStore)) {
    if (rateLimitStore[key].resetAt < now) delete rateLimitStore[key];
  }
}, 5 * 60 * 1000);

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

// ── Comptage conversations par clé API ──
// Structure : { apiKey: { count: Number, month: 'YYYY-MM', warned450: Boolean, billed500: Boolean } }
const conversationCounters = {};

const LIMIT_WARNING  = 450;
const LIMIT_BILLING  = 500;
const LIMIT_CUTOFF   = 550;
const OVERAGE_PRICE  = 0.10; // € par conv supplémentaire

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function getCounter(apiKey) {
  const month = getCurrentMonth();
  if (!conversationCounters[apiKey] || conversationCounters[apiKey].month !== month) {
    // Nouveau mois → reset
    conversationCounters[apiKey] = { count: 0, month, warned450: false, billed500: false };
  }
  return conversationCounters[apiKey];
}

async function sendLimitEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: 'NightAgent <contact@nightagent.fr>', to, subject, html })
  });
}

async function handleConversationCount(apiKey, shop) {
  const counter = getCounter(apiKey);
  counter.count++;
  const count = counter.count;
  const ownerEmail = shop.ownerEmail;

  // Seuil 450 — email d'avertissement (1 seul envoi par mois)
  if (count === LIMIT_WARNING && !counter.warned450 && ownerEmail) {
    counter.warned450 = true;
    sendLimitEmail({
      to: ownerEmail,
      subject: `[NightAgent] Vous approchez de votre limite mensuelle (${count} conversations)`,
      html: `
        <h2>⚠️ Limite bientôt atteinte</h2>
        <p>Votre boutique a utilisé <strong>${count} conversations</strong> ce mois-ci.</p>
        <p>À partir de 500 conversations, chaque échange supplémentaire est facturé <strong>${OVERAGE_PRICE}€</strong>.</p>
        <p>Pensez à passer sur le plan <strong>Pro (99€/mois, illimité)</strong> pour éviter des frais supplémentaires.</p>
        <p style="color:#888;font-size:12px;">NightAgent — support automatisé</p>
      `
    });
  }

  // Seuil 500 — email facturation surplus (1 seul envoi par mois)
  if (count === LIMIT_BILLING && !counter.billed500 && ownerEmail) {
    counter.billed500 = true;
    sendLimitEmail({
      to: ownerEmail,
      subject: `[NightAgent] Limite atteinte — facturation surplus activée`,
      html: `
        <h2>📊 Limite mensuelle atteinte</h2>
        <p>Votre boutique a atteint <strong>${count} conversations</strong> ce mois-ci.</p>
        <p>Les conversations supplémentaires sont désormais facturées <strong>${OVERAGE_PRICE}€ chacune</strong>.</p>
        <p>Le bot sera coupé à <strong>550 conversations</strong>. Passez sur le plan <strong>Pro</strong> pour éviter toute interruption.</p>
        <p style="color:#888;font-size:12px;">NightAgent — support automatisé</p>
      `
    });
  }

  return count;
}

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
      from: 'NightAgent <contact@nightagent.fr>',
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

  // Rate limiting par IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit('ip:' + ip, 20, 60 * 1000)) {
    return res.status(429).json({ error: 'Trop de requêtes. Merci de patienter une minute.' });
  }

  // Rate limiting par clé API
  if (apiKey && !checkRateLimit('key:' + apiKey.toLowerCase(), 60, 60 * 1000)) {
    return res.status(429).json({ error: 'Trop de requêtes. Merci de patienter une minute.' });
  }

  // Résolution des credentials Shopify via la clé API (jamais exposés au client)
  const shop = apiKey ? SHOPS[apiKey.toLowerCase()] : null;

  // Bloque si aucune clé valide — le widget doit toujours envoyer une clé NightAgent connue
  if (!shop) {
    return res.status(401).json({ error: 'Clé NightAgent invalide ou manquante. Vérifiez votre configuration.' });
  }

  // Comptage conversations + gestion seuils
  if (apiKey && shop) {
    const count = await handleConversationCount(apiKey.toLowerCase(), shop);
    if (count > LIMIT_CUTOFF) {
      return res.status(429).json({ error: 'Limite mensuelle atteinte. Veuillez contacter NightAgent pour continuer.' });
    }
  }

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
        from: 'NightAgent <contact@nightagent.fr>',
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
