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

/**
 * -------------------------
 * Helpers detalle (JSON)
 * -------------------------
 */
function normalizeCommuneLabel(commune) {
  const c = String(commune || "").trim().toLowerCase();
  if (!c) return "";
  if (c === "la-serena" || c === "laserena" || c === "la serena") return "La Serena";
  if (c === "coquimbo") return "Coquimbo";
  return String(commune);
}

function buildDetailObject(o) {
  const type = o?.shippingOption === "pickup" ? "pickup" : "delivery";

  if (type === "delivery") {
    const name = String(o?.delivery?.name || "");
    const phone = String(o?.delivery?.phone || "");
    const address = String(o?.delivery?.address || "");
    const commune = normalizeCommuneLabel(o?.delivery?.commune || "");
    const notes = String(o?.delivery?.notes || "");
    return { type, name, phone, address, commune, notes, rut: "" };
  }

  // pickup
  const name = String(o?.pickup?.name || "");
  const phone = String(o?.pickup?.phone || "");
  const rut = String(o?.pickup?.rut || "");
  return { type, name, phone, address: "", commune: "", notes: "", rut };
}

function buildDetailText(o) {
  const d = buildDetailObject(o);

  if (d.type === "delivery") {
    const parts = [];
    if (d.address) parts.push(d.address);
    if (d.commune) parts.push(d.commune);
    const base = parts.length ? parts.join(", ") : "-";
    return d.notes ? `Delivery: ${base}. Notas: ${d.notes}` : `Delivery: ${base}`;
  }

  // pickup
  return d.rut ? `Retiro en tienda. RUT: ${d.rut}` : "Retiro en tienda.";
}

/**
 * -------------------------
 * MercadoPago - Crear preferencia
 * -------------------------
 * Tu FRONTEND (index.html) llama a este endpoint
 */
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
    const now = Date.now();

    // Guardamos todo (incluye delivery/pickup)
    orders.set(orderId, {
      status: "created",
      items: mpItems,
      shippingOption,
      shippingCost: Number.isFinite(shipCost) ? shipCost : 0,
      delivery,
      pickup,
      createdAt: now,
      updatedAt: now,
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
    console.error("create_preference error:", status, mpData || err?.message || err);
    return res.status(status).json({
      error: "No se pudo crear preferencia",
      detail: mpData || String(err?.message ?? err),
    });
  }
});

/**
 * -------------------------
 * Endpoints JSON (con detail + detailText)
 * -------------------------
 */

// Ver 1 orden (demo)
app.get("/order/:id", (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: "Orden no encontrada" });

  const detail = buildDetailObject(o);
  const detailText = buildDetailText(o);

  res.json({ ...o, detail, detailText });
});

// Listar todas (sin orderId)
app.get("/orders", requireAdmin, (req, res) => {
  const list = Array.from(orders.entries()).map(([id, o]) => {
    const detail = buildDetailObject(o);
    const detailText = buildDetailText(o);
    return { id, ...o, detail, detailText };
  });

  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json(list);
});

// Solo pagos aprobados (sin orderId)
app.get("/payments", requireAdmin, (req, res) => {
  const list = Array.from(orders.entries())
    .map(([id, o]) => {
      const detail = buildDetailObject(o);
      const detailText = buildDetailText(o);
      return { id, ...o, detail, detailText };
    })
    .filter((o) => o.status === "approved")
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

  res.json(list);
});

/**
 * -------------------------
 * Webhook Mercado Pago
 * -------------------------
 */
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

/**
 * -------------------------
 * Vista HTML Admin
 * -------------------------
 */
function formatCLDateTime(ms) {
  if (!ms) return "-";
  return new Date(ms).toLocaleString("es-CL", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatCLP(n) {
  return Number(n || 0).toLocaleString("es-CL");
}

// Escape HTML correcto
function esc(s) {
  return String(s ?? "").replace(/[&<>\"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[c]));
}

function calcTotal(items = []) {
  return items.reduce(
    (sum, it) => sum + Number(it.unit_price || 0) * Number(it.quantity || 0),
    0
  );
}

function buildDetailHtml(o) {
  const d = buildDetailObject(o);

  if (d.type === "delivery") {
    const notesHtml = d.notes ? `<div class="muted">Notas: ${esc(d.notes)}</div>` : "";
    return `
      <div><strong>Dirección:</strong> ${esc(d.address || "-")}</div>
      <div><strong>Comuna:</strong> ${esc(d.commune || "-")}</div>
      ${notesHtml}
    `;
  }

  return d.rut ? `<div><strong>RUT:</strong> ${esc(d.rut)}</div>` : `<span class="muted">-</span>`;
}

function renderTablePage({ title, headerColor, rowsHtml }) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${esc(title)}</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#0b1220;color:#e5e7eb;margin:0;padding:18px}
    h1{margin:0 0 12px;font-size:20px}
    .card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:14px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{border-bottom:1px solid #1f2937;padding:10px;vertical-align:top}
    th{color:${headerColor};text-align:left;font-weight:700;white-space:nowrap}
    tr:hover td{background:#0f172a}
    .muted{color:#9ca3af;font-size:12px}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    .right{text-align:right;white-space:nowrap}
    .nowrap{white-space:nowrap}
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <div class="card">
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Estado</th>
          <th>Tipo</th>
          <th>Cliente</th>
          <th>Teléfono</th>
          <th>Detalle</th>
          <th>Primer ítem</th>
          <th>Total</th>
          <th>Creada</th>
          <th>Actualizada</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml || `<tr><td colspan="10" class="muted">No hay registros.</td></tr>`}
      </tbody>
    </table>
    <div class="muted" style="margin-top:10px;">Hora mostrada en America/Santiago.</div>
  </div>
</body>
</html>`;
}

app.get("/orders/view", requireAdmin, (req, res) => {
  const list = Array.from(orders.entries())
    .map(([id, o]) => ({ id, ...o }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const rowsHtml = list
    .map((o) => {
      const firstItem = o.items?.[0];
      const cliente =
        o.shippingOption === "pickup"
          ? (o.pickup?.name || "-")
          : (o.delivery?.name || "-");

      const telefono =
        o.shippingOption === "pickup"
          ? (o.pickup?.phone || "-")
          : (o.delivery?.phone || "-");

      const detailHtml = buildDetailHtml(o);

      return `
        <tr>
          <td class="mono">${esc(o.id)}</td>
          <td>${esc(o.status || "-")}</td>
          <td class="nowrap">${esc(o.shippingOption || "-")}</td>
          <td>${esc(cliente)}</td>
          <td class="nowrap">${esc(telefono)}</td>
          <td>${detailHtml}</td>
          <td>${esc(firstItem?.title || "-")}</td>
          <td class="right">$${formatCLP(calcTotal(o.items))}</td>
          <td class="nowrap">${esc(formatCLDateTime(o.createdAt))}</td>
          <td class="nowrap">${esc(formatCLDateTime(o.updatedAt))}</td>
        </tr>
      `;
    })
    .join("");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(renderTablePage({ title: "Órdenes (últimas primero)", headerColor: "#93c5fd", rowsHtml }));
});

app.get("/payments/view", requireAdmin, (req, res) => {
  const list = Array.from(orders.entries())
    .map(([id, o]) => ({ id, ...o }))
    .filter((o) => o.status === "approved")
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

  const rowsHtml = list
    .map((o) => {
      const firstItem = o.items?.[0];
      const cliente =
        o.shippingOption === "pickup"
          ? (o.pickup?.name || "-")
          : (o.delivery?.name || "-");

      const telefono =
        o.shippingOption === "pickup"
          ? (o.pickup?.phone || "-")
          : (o.delivery?.phone || "-");

      const detailHtml = buildDetailHtml(o);

      return `
        <tr>
          <td class="mono">${esc(o.id)}</td>
          <td>${esc(o.status || "-")}</td>
          <td class="nowrap">${esc(o.shippingOption || "-")}</td>
          <td>${esc(cliente)}</td>
          <td class="nowrap">${esc(telefono)}</td>
          <td>${detailHtml}</td>
          <td>${esc(firstItem?.title || "-")}</td>
          <td class="right">$${formatCLP(calcTotal(o.items))}</td>
          <td class="nowrap">${esc(formatCLDateTime(o.createdAt))}</td>
          <td class="nowrap">${esc(formatCLDateTime(o.updatedAt))}</td>
        </tr>
      `;
    })
    .join("");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(renderTablePage({ title: "Pagos aprobados", headerColor: "#86efac", rowsHtml }));
});

app.listen(process.env.PORT || 8080, () => {
  console.log("Backend listo en", process.env.PORT || 8080);
});
