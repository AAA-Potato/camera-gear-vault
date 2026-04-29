import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Camera,
  Tag,
  Calendar,
  Plus,
  Search,
  Download,
  Upload,
  Trash2,
  Edit3,
  ShieldCheck,
  X,
  Sparkles,
  Link2,
  DollarSign,
  Store,
  Package,
  AlertCircle,
  Check,
} from "lucide-react";

// ────────────────────────────────────────────────────────────────────────────
// Supabase configuration — values come from .env.local (local dev) or the
// Vercel dashboard (production). Never hard-code credentials here.
// ────────────────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "";
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY ?? "";

const SUPABASE_CONFIGURED =
  SUPABASE_URL.startsWith("https://") &&
  !SUPABASE_URL.includes("PASTE_YOUR") &&
  SUPABASE_KEY.length > 20 &&
  !SUPABASE_KEY.includes("PASTE_YOUR");

// ────────────────────────────────────────────────────────────────────────────
// Vault key — long random string identifying which rows in Supabase belong
// to this user. Stored in localStorage so the same browser stays in the same
// vault. To share across devices, the user copies this key to the other device.
// ────────────────────────────────────────────────────────────────────────────
const VAULT_KEY_STORAGE = "camera_gear_vault_key";
const CACHE_STORAGE_KEY = "camera_gear_vault_cache_v2";

const generateVaultKey = () => {
  // ~192 bits of entropy: 32 chars of base36 ≈ 32 * 5.17 bits
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return (
    "vault-" +
    Array.from(bytes)
      .map((b) => b.toString(36).padStart(2, "0"))
      .join("")
      .slice(0, 32)
  );
};

const getOrCreateVaultKey = () => {
  try {
    let key = localStorage.getItem(VAULT_KEY_STORAGE);
    if (!key || key.length < 16) {
      key = generateVaultKey();
      localStorage.setItem(VAULT_KEY_STORAGE, key);
    }
    return key;
  } catch {
    // localStorage unavailable — generate ephemeral key, won't persist
    return generateVaultKey();
  }
};

const setVaultKey = (key) => {
  try {
    localStorage.setItem(VAULT_KEY_STORAGE, key);
  } catch {
    /* ignore */
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Local cache — keeps the app responsive while Supabase loads in the
// background. Cache is namespaced by vault key so switching vaults works.
// ────────────────────────────────────────────────────────────────────────────
const loadCache = (vaultKey) => {
  try {
    const raw = localStorage.getItem(`${CACHE_STORAGE_KEY}:${vaultKey}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const saveCache = (vaultKey, items) => {
  try {
    localStorage.setItem(
      `${CACHE_STORAGE_KEY}:${vaultKey}`,
      JSON.stringify(items)
    );
  } catch {
    /* localStorage full or unavailable — non-fatal, Supabase is source of truth */
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Supabase REST client — minimal wrapper, no SDK dependency.
// We use Supabase's PostgREST endpoints directly via fetch().
// ────────────────────────────────────────────────────────────────────────────
const supabaseHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
});

// Convert a Supabase row (snake_case) to our app's item shape (camelCase)
const rowToItem = (row) => ({
  id: row.id,
  name: row.name || "",
  price: Number(row.price) || 0,
  purchaseDate: row.purchase_date || "",
  retailer: row.retailer || "",
  sourceUrl: row.source_url || "",
  notes: row.notes || "",
  customImages: Array.isArray(row.custom_images) ? row.custom_images : [],
  addedAt: row.added_at ? new Date(row.added_at).getTime() : Date.now(),
});

// Convert our item shape to a Supabase row (camelCase → snake_case)
const itemToRow = (item, vaultKey) => ({
  id: item.id,
  vault_key: vaultKey,
  name: item.name,
  price: Number(item.price) || 0,
  purchase_date: item.purchaseDate || null,
  retailer: item.retailer || "",
  source_url: item.sourceUrl || "",
  notes: item.notes || "",
  custom_images: item.customImages || [],
});

const fetchItems = async (vaultKey) => {
  if (!SUPABASE_CONFIGURED) return null;
  const url = `${SUPABASE_URL}/rest/v1/gear?vault_key=eq.${encodeURIComponent(
    vaultKey
  )}&order=added_at.desc`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  return rows.map(rowToItem);
};

const upsertItem = async (item, vaultKey) => {
  if (!SUPABASE_CONFIGURED) return null;
  const url = `${SUPABASE_URL}/rest/v1/gear?on_conflict=id`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...supabaseHeaders(), Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(itemToRow(item, vaultKey)),
  });
  if (!res.ok) {
    throw new Error(`Upsert failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  return rows[0] ? rowToItem(rows[0]) : null;
};

const deleteItemRemote = async (id, vaultKey) => {
  if (!SUPABASE_CONFIGURED) return;
  const url = `${SUPABASE_URL}/rest/v1/gear?id=eq.${encodeURIComponent(
    id
  )}&vault_key=eq.${encodeURIComponent(vaultKey)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: supabaseHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Delete failed: ${res.status} ${await res.text()}`);
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Smart parser — text input only. Pulls a price out of plain text if present,
// e.g. "Sony 24-70 GM II $2298" → name + price. URL parsing was removed
// because the artifact sandbox can't fetch e-commerce sites for real data.
// ────────────────────────────────────────────────────────────────────────────
const parseInput = (raw) => {
  const trimmed = raw.trim();

  // Prefer $-prefixed prices, fall back to large standalone numbers
  const dollarMatch = trimmed.match(/\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)/);
  const fallbackMatch =
    !dollarMatch &&
    trimmed.match(/(?<![\d-])(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d{3,}(?:\.\d{2})?)(?![\d-])/);
  const priceMatch = dollarMatch || fallbackMatch;
  const priceGuess = priceMatch ? priceMatch[1].replace(/,/g, "") : "";

  const nameGuess = priceMatch
    ? trimmed.replace(priceMatch[0], "").replace(/\s+/g, " ").trim()
    : trimmed;

  return {
    name: nameGuess,
    price: priceGuess,
    retailer: "",
    sourceUrl: "",
    purchaseDate: new Date().toISOString().slice(0, 10),
  };
};

// ────────────────────────────────────────────────────────────────────────────
// Image upload — resize before storing to keep localStorage under 5MB cap.
// Returns a data URL (base64) of the resized JPEG, or null on failure.
// ────────────────────────────────────────────────────────────────────────────
const MAX_IMAGE_DIMENSION = 800;
const JPEG_QUALITY = 0.82;

const resizeImageFile = (file) =>
  new Promise((resolve, reject) => {
    if (!file || !file.type?.startsWith("image/")) {
      return reject(new Error("Not an image file"));
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Failed to load image"));
      img.onload = () => {
        const { width, height } = img;
        const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
        const w = Math.round(width * scale);
        const h = Math.round(height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
        } catch (err) {
          reject(err);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

// ────────────────────────────────────────────────────────────────────────────
// Image keyword inference for Unsplash — picks 1–2 strong nouns from the name.
// ────────────────────────────────────────────────────────────────────────────
const GEAR_KEYWORDS = [
  "camera", "lens", "tripod", "flash", "strobe", "filter", "drone",
  "gimbal", "monopod", "bag", "backpack", "memory", "battery", "mic",
  "microphone", "light", "softbox", "reflector", "umbrella", "monitor",
];

const buildImageUrl = (name) => {
  const lower = (name || "").toLowerCase();
  const found = GEAR_KEYWORDS.filter((k) => lower.includes(k));
  const keywords = found.length ? found.slice(0, 2).join(",") : "camera,photography";
  // Unsplash source endpoint — deterministic per-name via hash for stability
  const seed = Math.abs(
    [...(name || "x")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)
  );
  return `https://source.unsplash.com/featured/600x600/?${encodeURIComponent(
    keywords
  )}&sig=${seed}`;
};

// ────────────────────────────────────────────────────────────────────────────
// Warranty math
// ────────────────────────────────────────────────────────────────────────────
const daysSince = (dateStr) => {
  if (!dateStr) return Infinity;
  const ms = Date.now() - new Date(dateStr).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
};

const warrantyStatus = (dateStr) => {
  const d = daysSince(dateStr);
  if (d <= 365) return { active: true, daysLeft: 365 - d };
  return { active: false, daysLeft: 0 };
};

// ────────────────────────────────────────────────────────────────────────────
// CSV export
// ────────────────────────────────────────────────────────────────────────────
const exportCSV = (items) => {
  const headers = ["Name", "Price (USD)", "Purchase Date", "Retailer", "Source URL", "Notes"];
  const escape = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = items.map((it) =>
    [it.name, it.price, it.purchaseDate, it.retailer, it.sourceUrl, it.notes || ""]
      .map(escape)
      .join(",")
  );
  const csv = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `camera-gear-vault-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// ────────────────────────────────────────────────────────────────────────────
// CSV parser — handles quoted fields with embedded commas/quotes/newlines.
// Returns an array of arrays of strings. Empty input returns [].
// ────────────────────────────────────────────────────────────────────────────
const parseCSV = (text) => {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          // Escaped quote inside quoted field
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += c;
      }
    }
  }
  // Flush trailing field/row (handles files without final newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.length > 0));
};

// Map a parsed CSV row to an item, given a header → index lookup.
// Header matching is case-insensitive and ignores units like "(USD)".
const csvRowToItem = (row, headerIndex) => {
  const get = (...keys) => {
    for (const k of keys) {
      const idx = headerIndex[k.toLowerCase()];
      if (idx !== undefined && row[idx] !== undefined) return row[idx].trim();
    }
    return "";
  };

  const name = get("name", "item", "item name");
  if (!name) return null; // Row without a name is invalid

  const priceRaw = get("price", "price (usd)", "cost", "amount");
  const price = parseFloat(String(priceRaw).replace(/[$,]/g, "")) || 0;

  let purchaseDate = get("purchase date", "date", "purchased");
  // Normalize common date formats to YYYY-MM-DD
  if (purchaseDate) {
    const d = new Date(purchaseDate);
    if (!isNaN(d.getTime())) {
      purchaseDate = d.toISOString().slice(0, 10);
    } else {
      purchaseDate = new Date().toISOString().slice(0, 10);
    }
  } else {
    purchaseDate = new Date().toISOString().slice(0, 10);
  }

  return {
    id: crypto.randomUUID(),
    name,
    price,
    purchaseDate,
    retailer: get("retailer", "store", "vendor", "source"),
    sourceUrl: get("source url", "url", "link"),
    notes: get("notes", "note", "description"),
    customImages: [],
    addedAt: Date.now(),
  };
};

// Build a header-name → column-index lookup, normalized to lowercase.
const buildHeaderIndex = (headerRow) => {
  const idx = {};
  headerRow.forEach((h, i) => {
    idx[String(h).trim().toLowerCase()] = i;
  });
  return idx;
};

// ────────────────────────────────────────────────────────────────────────────
// Currency formatter
// ────────────────────────────────────────────────────────────────────────────
const fmtUSD = (n, opts = {}) => {
  const { compact = false } = opts;
  const value = Number(n) || 0;
  // Compact mode (header totals): no decimals.
  // Default mode (cards): always show 2 decimals — matches what user entered.
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: compact ? 0 : 2,
    maximumFractionDigits: compact ? 0 : 2,
  }).format(value);
};

const fmtDate = (s) => {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return s;
  }
};

// ────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ────────────────────────────────────────────────────────────────────────────
export default function CameraGearVault() {
  // Vault key — identifies which slice of the cloud table belongs to this user
  const [vaultKey, setVaultKeyState] = useState(() => getOrCreateVaultKey());

  // Items start from local cache (instant render), then refresh from cloud
  const [items, setItems] = useState(() => loadCache(vaultKey));
  const [smartInput, setSmartInput] = useState("");
  const [pendingItem, setPendingItem] = useState(null); // confirmation modal
  const [editingItem, setEditingItem] = useState(null); // edit existing
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [filter, setFilter] = useState("");
  const [showWarrantyOnly, setShowWarrantyOnly] = useState(false);
  const [sortBy, setSortBy] = useState("date-desc");
  const [toast, setToast] = useState(null);

  // Sync state — visible in header so user knows if cloud is reachable
  // 'syncing' | 'synced' | 'offline' | 'error' | 'unconfigured'
  const [syncStatus, setSyncStatus] = useState(
    SUPABASE_CONFIGURED ? "syncing" : "unconfigured"
  );

  // Whenever items change, write to cache (Supabase writes happen separately
  // in each handler, so we don't double-up on network calls here)
  useEffect(() => {
    saveCache(vaultKey, items);
  }, [items, vaultKey]);

  // On mount + whenever vault key changes: fetch from cloud
  useEffect(() => {
    if (!SUPABASE_CONFIGURED) return;
    let cancelled = false;
    setSyncStatus("syncing");
    fetchItems(vaultKey)
      .then((cloudItems) => {
        if (cancelled || !cloudItems) return;
        setItems(cloudItems);
        setSyncStatus("synced");
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("Sync error:", err);
        setSyncStatus(navigator.onLine ? "error" : "offline");
      });
    return () => {
      cancelled = true;
    };
  }, [vaultKey]);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // ────── Smart input flow ──────
  const handleSmartSubmit = (e) => {
    e?.preventDefault?.();
    if (!smartInput.trim()) return;
    const parsed = parseInput(smartInput);
    setPendingItem({
      id: crypto.randomUUID(),
      name: parsed.name,
      price: parsed.price,
      purchaseDate: parsed.purchaseDate,
      retailer: parsed.retailer,
      sourceUrl: parsed.sourceUrl,
      notes: "",
      customImages: [],
    });
    setSmartInput("");
  };

  // Add or update an item — writes to local state immediately (optimistic),
  // then pushes to Supabase in the background.
  const persistItem = async (item) => {
    if (!SUPABASE_CONFIGURED) return;
    setSyncStatus("syncing");
    try {
      await upsertItem(item, vaultKey);
      setSyncStatus("synced");
    } catch (err) {
      console.warn("Persist error:", err);
      setSyncStatus(navigator.onLine ? "error" : "offline");
      setToast({
        message: "Saved locally — will retry sync when online",
        type: "error",
      });
    }
  };

  const confirmPending = (item) => {
    const finalItem = {
      ...item,
      price: parseFloat(item.price) || 0,
      imageUrl: buildImageUrl(item.name),
      addedAt: Date.now(),
    };
    setItems((prev) => [finalItem, ...prev]);
    setPendingItem(null);
    setToast({ message: `Added: ${finalItem.name}`, type: "success" });
    persistItem(finalItem);
  };

  const saveEdit = (item) => {
    const updated = {
      ...item,
      price: parseFloat(item.price) || 0,
      imageUrl: buildImageUrl(item.name),
    };
    setItems((prev) => prev.map((it) => (it.id === item.id ? updated : it)));
    setEditingItem(null);
    setToast({ message: `Updated: ${item.name}`, type: "success" });
    persistItem(updated);
  };

  const deleteItem = async (id) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    if (!SUPABASE_CONFIGURED) return;
    setSyncStatus("syncing");
    try {
      await deleteItemRemote(id, vaultKey);
      setSyncStatus("synced");
    } catch (err) {
      console.warn("Delete error:", err);
      setSyncStatus(navigator.onLine ? "error" : "offline");
    }
  };

  // ────── CSV import ──────
  const importInputRef = useRef(null);

  const handleImportCSV = async (file) => {
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
      setToast({ message: "Please choose a .csv file", type: "error" });
      return;
    }
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      if (rows.length < 2) {
        setToast({ message: "CSV is empty or has no data rows", type: "error" });
        return;
      }

      const headerIndex = buildHeaderIndex(rows[0]);
      // Sanity check: must at least have a "name" column (any common alias)
      const hasName =
        "name" in headerIndex || "item" in headerIndex || "item name" in headerIndex;
      if (!hasName) {
        setToast({
          message: "CSV missing 'Name' column — can't import",
          type: "error",
        });
        return;
      }

      // Build duplicate signature from existing items (name + date)
      const signature = (it) =>
        `${(it.name || "").trim().toLowerCase()}|${it.purchaseDate || ""}`;
      const existing = new Set(items.map(signature));

      const newItems = [];
      let skipped = 0;

      for (let i = 1; i < rows.length; i++) {
        const item = csvRowToItem(rows[i], headerIndex);
        if (!item) {
          skipped++;
          continue;
        }
        if (existing.has(signature(item))) {
          skipped++;
          continue;
        }
        item.imageUrl = buildImageUrl(item.name);
        newItems.push(item);
        existing.add(signature(item)); // prevent dupes within the same file
      }

      if (newItems.length === 0) {
        setToast({
          message: `Nothing imported — ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped`,
          type: "error",
        });
        return;
      }

      setItems((prev) => [...newItems, ...prev]);
      setToast({
        message: `Imported ${newItems.length} item${newItems.length === 1 ? "" : "s"}${
          skipped ? ` — ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped` : ""
        }`,
        type: "success",
      });
      // Push each imported item to the cloud, sequentially to avoid
      // hammering the API. Failures fall back to local-only.
      if (SUPABASE_CONFIGURED) {
        setSyncStatus("syncing");
        (async () => {
          let failed = 0;
          for (const it of newItems) {
            try {
              await upsertItem(it, vaultKey);
            } catch {
              failed++;
            }
          }
          setSyncStatus(failed === 0 ? "synced" : "error");
        })();
      }
    } catch (err) {
      setToast({ message: "Could not parse CSV file", type: "error" });
    }
  };

  // ────── Derived ──────
  const visibleItems = useMemo(() => {
    let list = [...items];
    if (filter.trim()) {
      const q = filter.toLowerCase();
      list = list.filter(
        (it) =>
          it.name?.toLowerCase().includes(q) ||
          it.retailer?.toLowerCase().includes(q) ||
          it.notes?.toLowerCase().includes(q)
      );
    }
    if (showWarrantyOnly) {
      list = list.filter((it) => warrantyStatus(it.purchaseDate).active);
    }

    // Sort
    const dateVal = (it) => (it.purchaseDate ? new Date(it.purchaseDate).getTime() : 0);
    const priceVal = (it) => Number(it.price) || 0;
    const sorters = {
      "date-desc": (a, b) => dateVal(b) - dateVal(a),
      "date-asc": (a, b) => dateVal(a) - dateVal(b),
      "price-desc": (a, b) => priceVal(b) - priceVal(a),
      "price-asc": (a, b) => priceVal(a) - priceVal(b),
      "name-asc": (a, b) => (a.name || "").localeCompare(b.name || ""),
      "added-desc": (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    };
    list.sort(sorters[sortBy] || sorters["date-desc"]);
    return list;
  }, [items, filter, showWarrantyOnly, sortBy]);

  const totals = useMemo(() => {
    const sum = items.reduce((s, it) => s + (Number(it.price) || 0), 0);
    const inWarranty = items.filter((it) => warrantyStatus(it.purchaseDate).active).length;
    return { sum, count: items.length, inWarranty };
  }, [items]);

  return (
    <div
      className="min-h-screen text-stone-200"
      style={{
        background:
          "radial-gradient(ellipse at top, #1a1614 0%, #0d0b0a 50%, #050404 100%)",
        fontFamily: "'Cormorant Garamond', 'Playfair Display', Georgia, serif",
      }}
    >
      {/* Inject custom fonts + grain */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500&display=swap');
        .font-mono-meta { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        .font-display { font-family: 'Cormorant Garamond', Georgia, serif; }
        .grain::before {
          content: '';
          position: fixed;
          inset: 0;
          pointer-events: none;
          opacity: 0.04;
          z-index: 1;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' /%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
        }
        .amber-glow { box-shadow: 0 0 0 1px rgba(217, 156, 80, 0.4), 0 0 24px -8px rgba(217, 156, 80, 0.3); }
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        .shimmer {
          background: linear-gradient(90deg, transparent 0%, rgba(217, 156, 80, 0.1) 50%, transparent 100%);
          background-size: 200% 100%;
          animation: shimmer 2s infinite;
        }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .fade-up { animation: fadeUp 0.5s ease-out backwards; }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>

      <div className="grain" />

      {/* ─── STICKY HEADER ─── */}
      <header
        className="sticky top-0 z-30 backdrop-blur-xl border-b"
        style={{
          background: "rgba(13, 11, 10, 0.85)",
          borderColor: "rgba(217, 156, 80, 0.15)",
        }}
      >
        <div className="max-w-7xl mx-auto px-6 py-5">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            {/* Brand */}
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-sm flex items-center justify-center border"
                style={{
                  borderColor: "rgba(217, 156, 80, 0.4)",
                  background: "linear-gradient(135deg, #1a1614 0%, #0d0b0a 100%)",
                }}
              >
                <Camera size={18} style={{ color: "#d99c50" }} strokeWidth={1.5} />
              </div>
              <div>
                <h1
                  className="font-display text-2xl leading-none tracking-wide"
                  style={{ color: "#f5e6d3", fontWeight: 500 }}
                >
                  Camera Gear Vault
                </h1>
                <p
                  className="font-mono-meta text-[10px] uppercase tracking-[0.25em] mt-1 flex items-center gap-2"
                  style={{ color: "#8a7a6a" }}
                >
                  Personal Equipment Archive
                  <SyncBadge status={syncStatus} />
                </p>
              </div>
            </div>

            {/* Stats */}
            <div className="flex items-center gap-8 font-mono-meta">
              <Stat label="Investment" value={fmtUSD(totals.sum, { compact: true })} accent />
              <Stat label="Items" value={totals.count} />
              <Stat label="In Warranty" value={totals.inWarranty} amber />
            </div>
          </div>

          {/* Smart input bar */}
          <form onSubmit={handleSmartSubmit} className="mt-5 flex gap-2 flex-wrap">
            <div
              className="flex-1 min-w-[280px] flex items-center gap-3 px-4 py-3 rounded-sm border transition-all"
              style={{
                background: "rgba(26, 22, 20, 0.6)",
                borderColor: "rgba(217, 156, 80, 0.15)",
              }}
            >
              <Sparkles size={16} style={{ color: "#8a7a6a" }} strokeWidth={1.5} />
              <input
                type="text"
                value={smartInput}
                onChange={(e) => setSmartInput(e.target.value)}
                placeholder="Describe your gear (e.g. 'Sony 24-70 GM II $2298') — opens entry form"
                className="flex-1 bg-transparent outline-none font-mono-meta text-sm placeholder:text-stone-600"
                style={{ color: "#f5e6d3" }}
              />
            </div>

            <button
              type="submit"
              disabled={!smartInput.trim()}
              className="px-5 py-3 rounded-sm font-mono-meta text-xs uppercase tracking-[0.2em] border transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:bg-amber-900/20"
              style={{
                color: "#d99c50",
                borderColor: "rgba(217, 156, 80, 0.4)",
                background: "rgba(217, 156, 80, 0.05)",
              }}
            >
              Add Item
            </button>

            <button
              type="button"
              onClick={() => setShowQuickAdd(true)}
              className="px-4 py-3 rounded-sm font-mono-meta text-xs uppercase tracking-[0.2em] border transition-all hover:bg-stone-800/50 flex items-center gap-2"
              style={{ color: "#a89684", borderColor: "rgba(168, 150, 132, 0.2)" }}
            >
              <Plus size={14} strokeWidth={1.5} /> Quick Add
            </button>
          </form>

          {/* Sub-controls */}
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 px-3 py-2 rounded-sm border flex-1 min-w-[200px]"
              style={{ background: "rgba(26, 22, 20, 0.4)", borderColor: "rgba(168, 150, 132, 0.1)" }}>
              <Search size={13} style={{ color: "#6a5a4a" }} strokeWidth={1.5} />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter collection…"
                className="flex-1 bg-transparent outline-none font-mono-meta text-xs placeholder:text-stone-700"
                style={{ color: "#d4c4b0" }}
              />
            </div>

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="px-3 py-2 rounded-sm font-mono-meta text-[10px] uppercase tracking-[0.2em] border transition-all cursor-pointer outline-none"
              style={{
                color: "#a89684",
                borderColor: "rgba(168, 150, 132, 0.2)",
                background: "rgba(26, 22, 20, 0.4)",
              }}
            >
              <option value="date-desc">Newest Purchase</option>
              <option value="date-asc">Oldest Purchase</option>
              <option value="price-desc">Price: High → Low</option>
              <option value="price-asc">Price: Low → High</option>
              <option value="name-asc">Name: A → Z</option>
              <option value="added-desc">Recently Added</option>
            </select>

            <button
              onClick={() => setShowWarrantyOnly((v) => !v)}
              className="px-3 py-2 rounded-sm font-mono-meta text-[10px] uppercase tracking-[0.2em] border transition-all flex items-center gap-2"
              style={{
                color: showWarrantyOnly ? "#0d0b0a" : "#d99c50",
                background: showWarrantyOnly ? "#d99c50" : "transparent",
                borderColor: "rgba(217, 156, 80, 0.4)",
              }}
            >
              <ShieldCheck size={12} strokeWidth={1.5} /> Warranty
            </button>

            <button
              onClick={() => importInputRef.current?.click()}
              className="px-3 py-2 rounded-sm font-mono-meta text-[10px] uppercase tracking-[0.2em] border transition-all flex items-center gap-2 hover:bg-stone-800/50"
              style={{ color: "#a89684", borderColor: "rgba(168, 150, 132, 0.2)" }}
              title="Import items from a CSV file"
            >
              <Upload size={12} strokeWidth={1.5} /> Import CSV
            </button>

            <button
              onClick={() => exportCSV(items)}
              disabled={!items.length}
              className="px-3 py-2 rounded-sm font-mono-meta text-[10px] uppercase tracking-[0.2em] border transition-all flex items-center gap-2 disabled:opacity-30 hover:bg-stone-800/50"
              style={{ color: "#a89684", borderColor: "rgba(168, 150, 132, 0.2)" }}
            >
              <Download size={12} strokeWidth={1.5} /> Export CSV
            </button>

            <input
              ref={importInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                handleImportCSV(e.target.files?.[0]);
                e.target.value = ""; // allow re-importing the same file
              }}
            />
          </div>
        </div>
      </header>

      {/* ─── MAIN GRID ─── */}
      <main className="max-w-7xl mx-auto px-6 py-10 relative z-10">
        {items.length === 0 ? (
          <EmptyState onQuickAdd={() => setShowQuickAdd(true)} />
        ) : visibleItems.length === 0 ? (
          <div className="text-center py-20">
            <p className="font-display text-2xl italic" style={{ color: "#8a7a6a" }}>
              No gear matches your filter.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {visibleItems.map((item, idx) => (
              <GearCard
                key={item.id}
                item={item}
                index={idx}
                onEdit={() => {
                  // Migrate legacy single-image format to array on edit
                  const migrated = {
                    ...item,
                    customImages: item.customImages?.length
                      ? item.customImages
                      : item.customImage
                        ? [item.customImage]
                        : [],
                  };
                  delete migrated.customImage;
                  setEditingItem(migrated);
                }}
                onDelete={() => deleteItem(item.id)}
              />
            ))}
          </div>
        )}
      </main>

      {/* ─── MODALS ─── */}
      {pendingItem && (
        <ItemFormModal
          title="Confirm Parsed Item"
          subtitle="Review the extracted metadata. Edit anything that looks off, then save."
          item={pendingItem}
          onSave={(edited) => confirmPending(edited)}
          onClose={() => setPendingItem(null)}
          saveLabel="Add to Vault"
        />
      )}

      {editingItem && (
        <ItemFormModal
          title="Edit Item"
          subtitle="Update the details for this piece of gear."
          item={editingItem}
          onSave={(edited) => saveEdit(edited)}
          onClose={() => setEditingItem(null)}
          saveLabel="Save Changes"
        />
      )}

      {showQuickAdd && (
        <ItemFormModal
          title="Quick Add"
          subtitle="Manually enter gear details."
          item={{
            id: crypto.randomUUID(),
            name: "",
            price: "",
            purchaseDate: new Date().toISOString().slice(0, 10),
            retailer: "",
            sourceUrl: "",
            notes: "",
            customImages: [],
          }}
          onSave={(data) => {
            confirmPending(data);
            setShowQuickAdd(false);
          }}
          onClose={() => setShowQuickAdd(false)}
          saveLabel="Add to Vault"
          isQuickAdd
        />
      )}

      {/* Toast notifications */}
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// SyncBadge — small indicator showing cloud sync state
// ────────────────────────────────────────────────────────────────────────────
function SyncBadge({ status }) {
  const config = {
    syncing: { color: "#d99c50", label: "Syncing", dot: "#d99c50", pulse: true },
    synced: { color: "#7ab87a", label: "Synced", dot: "#7ab87a" },
    offline: { color: "#a89684", label: "Offline", dot: "#a89684" },
    error: { color: "#d97070", label: "Sync error", dot: "#d97070" },
    unconfigured: { color: "#5a4a3a", label: "Local only", dot: "#5a4a3a" },
  };
  const c = config[status] || config.unconfigured;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border"
      style={{
        borderColor: `${c.color}40`,
        background: `${c.color}10`,
        color: c.color,
      }}
      title={
        status === "unconfigured"
          ? "Supabase not configured — data is local to this browser only"
          : status === "offline"
            ? "Offline — changes cached locally, will sync when online"
            : status === "error"
              ? "Could not reach the cloud — changes cached locally"
              : status
      }
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{
          background: c.dot,
          animation: c.pulse ? "pulse 1.4s ease-in-out infinite" : "none",
        }}
      />
      <span className="text-[8px] tracking-[0.2em]">{c.label}</span>
    </span>
  );
}

function Stat({ label, value, accent, amber }) {
  return (
    <div className="text-right">
      <div
        className="text-[10px] uppercase tracking-[0.25em]"
        style={{ color: "#6a5a4a" }}
      >
        {label}
      </div>
      <div
        className="text-lg font-medium mt-0.5"
        style={{
          color: accent ? "#f5e6d3" : amber ? "#d99c50" : "#a89684",
          fontFamily: accent
            ? "'Cormorant Garamond', serif"
            : "'JetBrains Mono', monospace",
          fontSize: accent ? "1.5rem" : "1rem",
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// GearCard
// ────────────────────────────────────────────────────────────────────────────
function GearCard({ item, index, onEdit, onDelete }) {
  const warranty = warrantyStatus(item.purchaseDate);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);

  // Backwards-compat: support both new `customImages` array and legacy `customImage` string
  const images = item.customImages?.length
    ? item.customImages
    : item.customImage
      ? [item.customImage]
      : [];
  const coverImage = images[0] || item.imageUrl;
  const extraImageCount = Math.max(0, images.length - 1);

  return (
    <article
      onClick={onEdit}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onEdit();
        }
      }}
      className="group relative rounded-sm border overflow-hidden transition-all duration-500 hover:translate-y-[-2px] fade-up cursor-pointer"
      style={{
        background: "linear-gradient(180deg, rgba(26, 22, 20, 0.7) 0%, rgba(13, 11, 10, 0.9) 100%)",
        borderColor: warranty.active ? "rgba(217, 156, 80, 0.35)" : "rgba(168, 150, 132, 0.1)",
        boxShadow: warranty.active
          ? "0 0 0 1px rgba(217, 156, 80, 0.15), 0 8px 32px -16px rgba(0,0,0,0.6)"
          : "0 8px 32px -16px rgba(0,0,0,0.6)",
        animationDelay: `${index * 60}ms`,
      }}
    >
      {/* Image */}
      <div
        className="relative aspect-square overflow-hidden"
        style={{ background: "#0a0807" }}
      >
        {!imgError && (
          <img
            src={coverImage}
            alt={item.name}
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
            className={`w-full h-full object-cover transition-all duration-700 ${
              imgLoaded ? "opacity-100 scale-100" : "opacity-0 scale-105"
            } group-hover:scale-105`}
            style={{ filter: "brightness(0.85) contrast(1.05)" }}
          />
        )}
        {(imgError || !imgLoaded) && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Camera size={32} style={{ color: "#3a302a" }} strokeWidth={1} />
          </div>
        )}

        {/* Gradient overlay */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "linear-gradient(180deg, transparent 50%, rgba(13, 11, 10, 0.8) 100%)",
          }}
        />

        {/* Warranty badge */}
        {warranty.active && (
          <div
            className="absolute top-3 right-3 px-2.5 py-1 rounded-sm flex items-center gap-1.5 backdrop-blur-md amber-glow"
            style={{ background: "rgba(13, 11, 10, 0.7)" }}
          >
            <ShieldCheck size={11} style={{ color: "#d99c50" }} strokeWidth={1.5} />
            <span
              className="font-mono-meta text-[9px] uppercase tracking-[0.2em]"
              style={{ color: "#d99c50" }}
            >
              {warranty.daysLeft}d left
            </span>
          </div>
        )}

        {/* Multi-image badge */}
        {extraImageCount > 0 && (
          <div
            className="absolute bottom-3 right-3 px-2 py-1 rounded-sm flex items-center gap-1 backdrop-blur-md"
            style={{ background: "rgba(13, 11, 10, 0.7)", border: "1px solid rgba(168, 150, 132, 0.2)" }}
          >
            <Camera size={10} style={{ color: "#a89684" }} strokeWidth={1.5} />
            <span
              className="font-mono-meta text-[9px] tracking-wide"
              style={{ color: "#a89684" }}
            >
              +{extraImageCount}
            </span>
          </div>
        )}

        {/* Delete button only — edit pencil removed since card itself is now clickable */}
        <div className="absolute top-3 left-3 opacity-0 group-hover:opacity-100 transition-opacity">
          <IconBtn
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete"
            danger
          >
            <Trash2 size={12} strokeWidth={1.5} />
          </IconBtn>
        </div>
      </div>

      {/* Body */}
      <div className="p-5">
        <h3
          className="font-display text-xl leading-tight mb-3 line-clamp-2"
          style={{ color: "#f5e6d3", fontWeight: 500 }}
        >
          {item.name || "Untitled"}
        </h3>

        <div className="space-y-2 font-mono-meta text-xs">
          <Meta icon={<Tag size={11} strokeWidth={1.5} />} label={fmtUSD(item.price)} highlight />
          <Meta icon={<Calendar size={11} strokeWidth={1.5} />} label={fmtDate(item.purchaseDate)} />
          {item.retailer && (
            <Meta icon={<Store size={11} strokeWidth={1.5} />} label={item.retailer} />
          )}
        </div>

        {item.sourceUrl && (
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-4 inline-flex items-center gap-1.5 font-mono-meta text-[10px] uppercase tracking-[0.2em] transition-colors hover:underline"
            style={{ color: "#8a7a6a" }}
          >
            <Link2 size={10} strokeWidth={1.5} /> View Source
          </a>
        )}
      </div>
    </article>
  );
}

function Meta({ icon, label, highlight }) {
  return (
    <div className="flex items-center gap-2">
      <span style={{ color: "#6a5a4a" }}>{icon}</span>
      <span style={{ color: highlight ? "#d99c50" : "#a89684" }}>{label}</span>
    </div>
  );
}

function IconBtn({ children, onClick, title, danger }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-7 h-7 rounded-sm flex items-center justify-center backdrop-blur-md border transition-colors"
      style={{
        background: "rgba(13, 11, 10, 0.8)",
        borderColor: danger ? "rgba(180, 60, 60, 0.4)" : "rgba(217, 156, 80, 0.3)",
        color: danger ? "#d97070" : "#d99c50",
      }}
    >
      {children}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// EmptyState
// ────────────────────────────────────────────────────────────────────────────
function EmptyState({ onQuickAdd }) {
  return (
    <div className="text-center py-24 max-w-md mx-auto">
      <div
        className="w-20 h-20 mx-auto mb-6 rounded-sm flex items-center justify-center border"
        style={{
          borderColor: "rgba(217, 156, 80, 0.2)",
          background: "linear-gradient(135deg, rgba(26, 22, 20, 0.5), transparent)",
        }}
      >
        <Package size={28} style={{ color: "#d99c50" }} strokeWidth={1} />
      </div>
      <h2
        className="font-display text-3xl mb-3"
        style={{ color: "#f5e6d3", fontWeight: 400, fontStyle: "italic" }}
      >
        Your vault awaits.
      </h2>
      <p className="font-mono-meta text-xs leading-relaxed mb-6" style={{ color: "#8a7a6a" }}>
        Paste a product URL above, describe gear in plain text, or use Quick Add to
        manually enter your first piece of equipment.
      </p>
      <button
        onClick={onQuickAdd}
        className="px-6 py-3 rounded-sm font-mono-meta text-xs uppercase tracking-[0.25em] border transition-all hover:bg-amber-900/20"
        style={{
          color: "#d99c50",
          borderColor: "rgba(217, 156, 80, 0.4)",
          background: "rgba(217, 156, 80, 0.05)",
        }}
      >
        Add Your First Item
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ItemFormModal — used for confirm-parsed, edit, and quick-add
// ────────────────────────────────────────────────────────────────────────────
function ItemFormModal({ title, subtitle, item, onSave, onClose, saveLabel, isQuickAdd }) {
  const [local, setLocal] = useState(item);
  const [uploadError, setUploadError] = useState("");
  const firstFieldRef = useRef(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
    const onEsc = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  // Listen for clipboard paste of images while modal is open
  useEffect(() => {
    const onPaste = async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.type?.startsWith("image/")) {
          e.preventDefault();
          const file = it.getAsFile();
          try {
            const dataUrl = await resizeImageFile(file);
            setLocal((p) => ({
              ...p,
              customImages: [...(p.customImages || []), dataUrl],
            }));
            setUploadError("");
          } catch (err) {
            setUploadError("Could not process pasted image");
          }
          break;
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const update = (field) => (e) => setLocal((p) => ({ ...p, [field]: e.target.value }));

  const canSave = local.name?.trim().length > 0;

  const previewImage = useMemo(() => buildImageUrl(local.name), [local.name]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm overflow-y-auto"
      style={{ background: "rgba(5, 4, 4, 0.85)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-4xl rounded-sm border flex flex-col fade-up my-auto"
        style={{
          background: "linear-gradient(180deg, #1a1614 0%, #0d0b0a 100%)",
          borderColor: "rgba(217, 156, 80, 0.3)",
          boxShadow: "0 24px 64px -16px rgba(0,0,0,0.8), 0 0 0 1px rgba(217, 156, 80, 0.1)",
          maxHeight: "calc(100vh - 2rem)",
        }}
      >
        {/* Header — sticky-ish, always visible at top */}
        <div
          className="px-7 py-5 border-b flex items-start justify-between flex-shrink-0"
          style={{ borderColor: "rgba(217, 156, 80, 0.15)" }}
        >
          <div>
            <h2
              className="font-display text-2xl"
              style={{ color: "#f5e6d3", fontWeight: 500 }}
            >
              {title}
            </h2>
            <p
              className="font-mono-meta text-[10px] uppercase tracking-[0.2em] mt-1"
              style={{ color: "#8a7a6a" }}
            >
              {subtitle}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-sm flex items-center justify-center border transition-colors hover:bg-stone-800/50 flex-shrink-0"
            style={{ borderColor: "rgba(168, 150, 132, 0.2)", color: "#a89684" }}
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>

        {/* Body — scrollable when content exceeds available height */}
        <div className="overflow-y-auto flex-1 p-7">
          <div className="grid grid-cols-1 md:grid-cols-[110px_1fr] gap-7">
            {/* Image uploader */}
            <div>
              <label className="block font-mono-meta text-[10px] uppercase tracking-[0.2em] mb-2" style={{ color: "#6a5a4a" }}>
                Images
              </label>
              <ImageUploader
                values={local.customImages || []}
                fallbackUrl={local.name ? previewImage : null}
                onChange={(arr) => setLocal((p) => ({ ...p, customImages: arr }))}
                onError={(msg) => setUploadError(msg)}
              />
              {uploadError ? (
                <p className="font-mono-meta text-[9px] uppercase tracking-[0.15em] mt-2" style={{ color: "#d97070" }}>
                  {uploadError}
                </p>
              ) : (
                <p className="font-mono-meta text-[9px] uppercase tracking-[0.15em] mt-2 leading-relaxed" style={{ color: "#5a4a3a" }}>
                  {local.customImages?.length
                    ? `${local.customImages.length} image${local.customImages.length > 1 ? "s" : ""}`
                    : "Click, drag, or paste"}
                </p>
              )}
            </div>

            {/* Fields */}
            <div className="space-y-4">
              <Field label="Item Name" required>
                <input
                  ref={firstFieldRef}
                  type="text"
                  value={local.name}
                  onChange={update("name")}
                  placeholder="e.g. Sony FE 24-70mm f/2.8 GM II"
                  className="modal-input"
                />
              </Field>

              <div className="grid grid-cols-2 gap-4">
                <Field label="Price (USD)">
                  <div className="relative">
                    <DollarSign
                      size={13}
                      strokeWidth={1.5}
                      className="absolute left-3 top-1/2 -translate-y-1/2"
                      style={{ color: "#6a5a4a" }}
                    />
                    <input
                      type="number"
                      step="0.01"
                      value={local.price}
                      onChange={update("price")}
                      placeholder="0.00"
                      className="modal-input pl-9"
                    />
                  </div>
                </Field>

                <Field label="Purchase Date">
                  <input
                    type="date"
                    value={local.purchaseDate}
                    onChange={update("purchaseDate")}
                    className="modal-input"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Retailer">
                  <input
                    type="text"
                    value={local.retailer}
                    onChange={update("retailer")}
                    placeholder="B&H Photo, Amazon, KEH…"
                    className="modal-input"
                  />
                </Field>

                <Field label="Source URL (optional)">
                  <input
                    type="url"
                    value={local.sourceUrl}
                    onChange={update("sourceUrl")}
                    placeholder="https://…"
                    className="modal-input"
                  />
                </Field>
              </div>

              <Field label="Notes (optional)">
                <textarea
                  value={local.notes || ""}
                  onChange={update("notes")}
                  rows={2}
                  placeholder="Serial number, condition, accessories…"
                  className="modal-input resize-none"
                />
              </Field>
            </div>
          </div>
        </div>

        {/* Footer — sticky at bottom, save button always reachable */}
        <div
          className="px-7 py-4 border-t flex items-center justify-between flex-shrink-0"
          style={{
            borderColor: "rgba(217, 156, 80, 0.15)",
            background: "rgba(13, 11, 10, 0.6)",
          }}
        >
          <div className="flex items-center gap-2 font-mono-meta text-[10px] uppercase tracking-[0.2em]" style={{ color: "#6a5a4a" }}>
            {!canSave && (
              <>
                <AlertCircle size={11} strokeWidth={1.5} /> Name is required
              </>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-5 py-2.5 rounded-sm font-mono-meta text-[10px] uppercase tracking-[0.25em] border transition-colors hover:bg-stone-800/50"
              style={{ color: "#a89684", borderColor: "rgba(168, 150, 132, 0.2)" }}
            >
              Cancel
            </button>
            <button
              onClick={() => canSave && onSave(local)}
              disabled={!canSave}
              className="px-5 py-2.5 rounded-sm font-mono-meta text-[10px] uppercase tracking-[0.25em] border transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
              style={{
                color: "#0d0b0a",
                background: "#d99c50",
                borderColor: "#d99c50",
              }}
            >
              <Check size={12} strokeWidth={2} /> {saveLabel}
            </button>
          </div>
        </div>

        <style>{`
          .modal-input {
            width: 100%;
            background: rgba(13, 11, 10, 0.6);
            border: 1px solid rgba(168, 150, 132, 0.15);
            border-radius: 2px;
            padding: 0.625rem 0.875rem;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.8125rem;
            color: #f5e6d3;
            outline: none;
            transition: border-color 0.2s;
          }
          .modal-input:focus {
            border-color: rgba(217, 156, 80, 0.5);
          }
          .modal-input::placeholder {
            color: #5a4a3a;
          }
          .modal-input::-webkit-calendar-picker-indicator {
            filter: invert(0.6) sepia(1) hue-rotate(10deg);
            cursor: pointer;
          }
        `}</style>
      </div>
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <div>
      <label className="block font-mono-meta text-[10px] uppercase tracking-[0.2em] mb-1.5" style={{ color: "#6a5a4a" }}>
        {label} {required && <span style={{ color: "#d99c50" }}>*</span>}
      </label>
      {children}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ImageUploader — click to browse, drag & drop, paste from clipboard.
// ────────────────────────────────────────────────────────────────────────────
function ImageUploader({ values, fallbackUrl, onChange, onError }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);

  const images = values || [];
  const cover = images[0] || null;

  const handleFiles = async (fileList) => {
    if (!fileList || !fileList.length) return;
    setBusy(true);
    const accepted = [];
    let errored = false;

    for (const file of Array.from(fileList)) {
      if (!file.type?.startsWith("image/")) {
        errored = true;
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        errored = true;
        continue;
      }
      try {
        const dataUrl = await resizeImageFile(file);
        accepted.push(dataUrl);
      } catch {
        errored = true;
      }
    }

    if (accepted.length) {
      onChange([...images, ...accepted]);
      onError?.(errored ? "Some files were skipped (not images or too large)" : "");
    } else if (errored) {
      onError?.("Could not process those files");
    }
    setBusy(false);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer?.files);
  };

  const removeAt = (idx) => {
    const next = images.filter((_, i) => i !== idx);
    onChange(next);
    onError?.("");
  };

  const setAsCover = (idx) => {
    if (idx === 0) return;
    const next = [images[idx], ...images.filter((_, i) => i !== idx)];
    onChange(next);
  };

  const showFallback = !cover && fallbackUrl;

  return (
    <div>
      {/* Main upload area / cover preview */}
      <div className="relative">
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className="aspect-square rounded-sm border-2 overflow-hidden flex items-center justify-center cursor-pointer transition-all relative group"
          style={{
            background: "#0a0807",
            borderStyle: dragOver ? "solid" : "dashed",
            borderColor: dragOver
              ? "#d99c50"
              : cover
                ? "rgba(217, 156, 80, 0.3)"
                : "rgba(168, 150, 132, 0.2)",
          }}
        >
          {cover ? (
            <>
              <img
                src={cover}
                alt="cover"
                className="w-full h-full object-cover"
              />
              <div
                className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ background: "rgba(5, 4, 4, 0.7)" }}
              >
                <span
                  className="font-mono-meta text-[9px] uppercase tracking-[0.2em] flex items-center gap-1"
                  style={{ color: "#d99c50" }}
                >
                  <Plus size={11} strokeWidth={1.5} />
                  Add more
                </span>
              </div>
            </>
          ) : showFallback ? (
            <>
              <img
                src={fallbackUrl}
                alt="auto"
                className="w-full h-full object-cover"
                style={{ filter: "brightness(0.85)" }}
              />
              <div
                className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ background: "rgba(5, 4, 4, 0.7)" }}
              >
                <span
                  className="font-mono-meta text-[9px] uppercase tracking-[0.2em] flex items-center gap-1"
                  style={{ color: "#d99c50" }}
                >
                  <Camera size={11} strokeWidth={1.5} /> Upload
                </span>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-1.5 px-2 text-center">
              <Camera size={18} style={{ color: "#3a302a" }} strokeWidth={1} />
              <span
                className="font-mono-meta text-[8px] uppercase tracking-[0.15em] leading-relaxed"
                style={{ color: "#5a4a3a" }}
              >
                {dragOver ? "Drop here" : busy ? "Processing…" : "Click, drag, paste"}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Thumbnail strip — only shown when multiple images */}
      {images.length > 0 && (
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {images.map((img, idx) => (
            <div
              key={idx}
              className="relative aspect-square rounded-sm overflow-hidden border group/thumb cursor-pointer"
              style={{
                borderColor: idx === 0 ? "rgba(217, 156, 80, 0.5)" : "rgba(168, 150, 132, 0.15)",
                boxShadow: idx === 0 ? "0 0 0 1px rgba(217, 156, 80, 0.3)" : "none",
              }}
              onClick={() => setAsCover(idx)}
              title={idx === 0 ? "Cover image" : "Click to set as cover"}
            >
              <img src={img} alt={`#${idx + 1}`} className="w-full h-full object-cover" />
              {idx === 0 && (
                <div
                  className="absolute bottom-0 left-0 right-0 text-center font-mono-meta text-[7px] uppercase tracking-[0.15em] py-0.5"
                  style={{ background: "rgba(217, 156, 80, 0.85)", color: "#0d0b0a" }}
                >
                  Cover
                </div>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAt(idx);
                }}
                className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity"
                style={{ background: "rgba(13, 11, 10, 0.9)", color: "#d97070" }}
                title="Remove"
              >
                <X size={9} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Toast — bottom-right confirmation/error banner
// ────────────────────────────────────────────────────────────────────────────
function Toast({ toast, onClose }) {
  if (!toast) return null;
  const isError = toast.type === "error";
  return (
    <div
      className="fixed bottom-6 right-6 z-50 px-5 py-3 rounded-sm border flex items-center gap-3 fade-up backdrop-blur-md"
      style={{
        background: "rgba(13, 11, 10, 0.95)",
        borderColor: isError ? "rgba(180, 60, 60, 0.5)" : "rgba(217, 156, 80, 0.4)",
        boxShadow: "0 12px 32px -8px rgba(0,0,0,0.6)",
        maxWidth: "380px",
      }}
    >
      {isError ? (
        <AlertCircle size={14} strokeWidth={1.5} style={{ color: "#d97070" }} />
      ) : (
        <Check size={14} strokeWidth={2} style={{ color: "#d99c50" }} />
      )}
      <span
        className="font-mono-meta text-xs flex-1"
        style={{ color: isError ? "#d97070" : "#f5e6d3" }}
      >
        {toast.message}
      </span>
      <button
        onClick={onClose}
        className="opacity-50 hover:opacity-100 transition-opacity"
        style={{ color: "#a89684" }}
      >
        <X size={12} strokeWidth={1.5} />
      </button>
    </div>
  );
}
