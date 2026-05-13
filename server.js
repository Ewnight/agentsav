const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── Cherche une commande Shopify par numéro ou email ──
async function findShopifyOrder(query, shopDomain, accessToken) {
  if (!shopDomain || !accessToken) return null;

  try {
    // Cherche par numéro de commande (ex: #1234 ou 1234)
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

    // Résumé lisible de la commande
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

// ── Route principale chat ──
app.post('/chat', async (req, res) => {
  const { messages, system, shopDomain, shopToken } = req.body;

  if (!messages || !system) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  // Cherche une commande si le dernier message du client en mentionne une
  const lastMessage = messages[messages.length - 1]?.content || '';
  const orderMentioned = /commande|order|#\d{3,}|\d{4,}|suivi|livraison|où est/i.test(lastMessage);

  let orderContext = '';
  if (orderMentioned && shopDomain && shopToken) {
    const order = await findShopifyOrder(lastMessage, shopDomain, shopToken);
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

app.get('/', (req, res) => res.send('Agent SAV OK ✓'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur SAV lancé sur le port ${PORT}`));
