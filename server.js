import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// demo (en producción usa BD)
const orders = new Map();

function newOrderId() {
  return crypto.randomUUID();
}

// --- Auth opcional para endpoints admin ---
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
function requireAdmin(req, res, next) {
  // Si no defines ADMIN_TOKEN, no bloquea (modo simple)
  if (!ADMIN_TOKEN) return next();

  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "Unauthorized" });

  next();
}

app.get("/health", (req, res) => res.json({ ok: true }));

// Tu FRONTEND (index.html) llama a este endpoint
app.post("/create_preference", async (req, res) => {
  try {
    const {
      items = [],
      shippingOption = "delivery",
      shippingCost = 0,
      delivery = null,
      pickup = null,
    } = req.body ?? {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items vacío" });
    }

    if (!process.env.MP_ACCESS_TOKEN) {
      return res.status(500).json({ error: "Falta MP_ACCESS_TOKEN en .env" });
    }

    // Tu HTML envía: {title, unitprice, quantity}
    const mpItems = items.map((i) => ({
      title: String(i.title ?? "").trim(),
      quantity: Number(i.quantity ?? 1),
      unit_price: Number(i.unitprice ?? 0),
      currency_id: "CLP",
    }));

    const invalid = mpItems.some(
      (i) =>
        !i.title ||
        !Number.isFinite(i.quantity) ||
        i.quantity <= 0 ||
        !Number.isFinite(i.unit_price) ||
        i.unit_price <= 0
    );
    if (invalid) {
      return res.status(400).json({ error: "items inválidos", mpItems });
    }

    // Si hay delivery, agrega el costo como “ítem”
    const shipCost = Number(shippingCost ?? 0);
    if (shippingOption === "delivery" && Number.isFinite(shipCost) && shipCost > 0) {
      mpItems.push({
        title: "Envío (Delivery)",
        quantity: 1,
        unit_price: shipCost,
        currency_id: "CLP",
      });
    }

    const orderId = newOrderId();

    // Guardamos todo (incluye delivery/pickup)
    orders.set(orderId, {
      status: "created",
      items: mpItems,
      shippingOption,
      shippingCost: Number.isFinite(shipCost) ? shipCost : 0,
      delivery,
      pickup,
      createdAt: Date.now(),
    });

    const preferenceBody = {
      items: mpItems,
      external_reference: orderId,
      notification_url: process.env.MP_NOTIFICATION_URL || undefined,
      back_urls: {
        success: process.env.FRONT_SUCCESS_URL || undefined,
        failure: process.env.FRONT_FAILURE_URL || undefined,
        pending: process.env.FRONT_PENDING_URL || undefined,
      },
      auto_return: "approved",
    };

    const r = await axios.post(
      "https://api.mercadopago.com/checkout/preferences",
      preferenceBody,
      { headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` } }
    );

    // init_point es el link de pago, tu frontend espera "initpoint"
    return res.json({
      initpoint: r.data.init_point,
      orderId,
      preferenceId: r.data.id,
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    const mpData = err?.response?.data;

    console.error("MP ERROR STATUS:", status);
    console.error("MP ERROR DATA:", mpData);

    return res.status(status).json({
      error: "No se pudo crear preferencia",
      detail: mpData || String(err?.message ?? err),
    });
  }
});

// Ver 1 orden (demo)
app.get("/order/:id", (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: "Orden no encontrada" });
  res.json(o);
});

// Listar todas (sin orderId)
app.get("/orders", requireAdmin, (req, res) => {
  const list = Array.from(orders.entries()).map(([id, o]) => ({ id, ...o }));
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json(list);
});

// Solo pagos aprobados (sin orderId)
app.get("/payments", requireAdmin, (req, res) => {
  const list = Array.from(orders.entries())
    .map(([id, o]) => ({ id, ...o }))
    .filter((o) => o.status === "approved")
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  res.json(list);
});

// Webhook Mercado Pago
app.post("/webhook/mercadopago", async (req, res) => {
  try {
    // Responder rápido para que MP no reintente
    res.sendStatus(200);

    const topic = req.query.topic || req.query.type;
    const id = req.query.id || req.body?.data?.id;

    if (!id) return;
    if (topic && topic !== "payment") return;
    if (!process.env.MP_ACCESS_TOKEN) return;

    const pay = await axios.get(`https://api.mercadopago.com/v1/payments/${id}`, {
      headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });

    const payment = pay.data;
    const orderId = payment.external_reference;

    if (!orderId || !orders.has(orderId)) return;

    const old = orders.get(orderId);
    orders.set(orderId, {
      ...old,
      status: payment.status, // approved / rejected / pending, etc.
      paymentId: payment.id,
      paymentStatusDetail: payment.status_detail,
      updatedAt: Date.now(),
    });
  } catch (e) {
    console.error("Webhook error:", e?.response?.data || e?.message || e);
  }
});

app.listen(process.env.PORT || 8080, () => {
  console.log("Backend listo en 8080");
});
