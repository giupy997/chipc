/**
 * pin.mjs — mette su IPFS il logo di un chip.
 *
 * Il contratto salva un URI, non l'immagine. Quindi "carica dal PC" vuol dire
 * pinnare prima e mintare dopo, e il pinning ha bisogno di una chiave che nel
 * browser non puo' stare: chiunque la userebbe per riempire il tuo account.
 * Per questo il file passa da qui.
 *
 * Variabile d'ambiente richiesta su Netlify:
 *   PINATA_JWT   la JWT dell'account Pinata
 */

const MAX_BYTES = 1024 * 1024; // 1 MB: un logo non ha bisogno di piu'

/**
 * Firme dei formati accettati.
 *
 * Il content-type dichiarato dal client non conta niente — chiunque puo'
 * scrivere `image/png` sopra un file HTML. Contano i primi byte.
 *
 * L'SVG e' escluso apposta: puo' contenere script, e un SVG diventa
 * l'immagine di un NFT che verra' aperta nei browser di altre persone.
 */
const MAGIC = [
  { mime: "image/png",  test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif",  test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    mime: "image/webp",
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

const fail = (status, error) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });

// Un freno per chi volesse riempire l'account Pinata da fuori: solo dal
// nostro sito, e non piu' di qualche pin al minuto per indirizzo. La memoria
// vive nell'istanza della function (ne bastano pochi minuti), non e' un
// muro, e' un tornello.
const ALLOWED_ORIGINS = ["https://rh4cpu.tech", "https://www.rh4cpu.tech"];
const RATE = { window: 60_000, max: 6 };
const hits = new Map();
function throttled(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE.window);
  if (arr.length >= RATE.max) { hits.set(ip, arr); return true; }
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

export default async (req, context) => {
  if (req.method !== "POST") return fail(405, "solo POST");
  const origin = req.headers.get("origin") || "";
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return fail(403, "origine non consentita");
  const ip = (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "?";
  if (throttled(ip)) return fail(429, "troppi caricamenti: riprova fra un minuto");

  const jwt = process.env.PINATA_JWT;
  if (!jwt) return fail(500, "PINATA_JWT non configurata su Netlify");

  let file;
  try {
    file = (await req.formData()).get("file");
  } catch {
    return fail(400, "corpo non valido: serve multipart/form-data con un campo `file`");
  }
  if (!file || typeof file === "string") return fail(400, "manca il campo `file`");
  if (file.size > MAX_BYTES) {
    return fail(413, `troppo grande: ${Math.round(file.size / 1024)} kB, il limite e' 1024 kB`);
  }
  if (file.size === 0) return fail(400, "file vuoto");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = MAGIC.find((m) => m.test(bytes));
  if (!kind) {
    return fail(415, "formato non riconosciuto: accetto PNG, JPEG, GIF o WebP (SVG no, puo' contenere script)");
  }

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: kind.mime }), file.name || "logo");
  // Pinata pinna in privato se non gli si dice altro, e un'immagine privata
  // lascerebbe muto ogni NFT che la referenzia.
  form.append("network", "public");

  let res;
  try {
    res = await fetch("https://uploads.pinata.cloud/v3/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    });
  } catch (e) {
    return fail(502, `Pinata non raggiungibile: ${e.message}`);
  }

  const body = await res.text();
  if (!res.ok) return fail(502, `Pinata ha risposto ${res.status}: ${body.slice(0, 200)}`);

  let cid;
  try {
    cid = JSON.parse(body)?.data?.cid;
  } catch {
    return fail(502, "risposta di Pinata non leggibile");
  }
  if (!cid) return fail(502, "Pinata non ha restituito un CID");

  return new Response(
    JSON.stringify({
      uri: `ipfs://${cid}`,
      preview: `https://gateway.pinata.cloud/ipfs/${cid}`,
      bytes: file.size,
      mime: kind.mime,
    }),
    { headers: { "content-type": "application/json" } }
  );
};

export const config = { path: "/api/pin" };
