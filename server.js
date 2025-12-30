import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const orders = new Map(); // demo (en producción usa BD)

function newOrderId() {
  return crypto.randomUUID();
}

app.get("/health", (req, res) => res.json({ ok: true }));

// Tu FRONTEND (index.html) llama a este endpoint
app.post("/create_preference", async (req, res) => {
  try {
    const { items = [], shippingOption, shippingCost = 0 } = req.body ?? {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items vacío" });
    }

    // Tu HTML envía: {title, unitprice, quantity}
    const mpItems = items.map((i) => ({
      title: String(i.title ?? ""),
      quantity: Number(i.quantity ?? 1),
      unit_price: Number(i.unitprice ?? 0),
      // Si tu cuenta es Chile, normalmente ayuda dejar esto fijo:
      currency_id: "CLP",
    }));

    if (
      mpItems.some(
        (i) =>
          !i.title ||
          !Number.isFinite(i.quantity) ||
          i.quantity <= 0 ||
          !Number.isFinite(i.unit_price) ||
          i.unit_price <= 0
      )
    ) {
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
    orders.set(orderId, { status: "created", items: mpItems, createdAt: Date.now() });

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

    if (!process.env.MP_ACCESS_TOKEN) {
      return res.status(500).json({ error: "Falta MP_ACCESS_TOKEN en .env" });
    }

    const r = await axios.post(
      "https://api.mercadopago.com/checkout/preferences",
      preferenceBody,
      { headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` } }
    );

    // init_point es el link de pago, tu frontend espera "initpoint"
    return res.json({ initpoint: r.data.init_point, orderId, preferenceId: r.data.id });
  } catch (err) {
    const status = err?.response?.status || 500;
    const mpData = err?.response?.data;

    // Esto es clave: acá viene el motivo real del 400/401/etc.
    console.error("MP ERROR STATUS:", status);
    console.error("MP ERROR DATA:", mpData);

    return res.status(status).json({
      error: "No se pudo crear preferencia",
      detail: mpData || String(err?.message ?? err),
    });
  }
});

// Para ver el estado (demo)
app.get("/order/:id", (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: "Orden no encontrada" });
  res.json(o);
});

// Webhook: Mercado Pago avisa pagos; luego confirmas consultando el pago por ID
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
      updatedAt: Date.now(),
    });
  } catch (e) {
    // ya se respondió 200, solo log
    console.error("Webhook error:", e?.message ?? e);
  }
});

app.listen(process.env.PORT || 8080, () => console.log("Backend listo en 8080"));
