const CDN_BASE = "https://cdn.starkbilisim.com/api/api.php";
const API_KEY = process.env.STARKCDN_API_KEY || "";
const PROJECT_ID = process.env.STARKCDN_PROJECT_ID || "8";

async function uploadImage(buffer, filename, mimetype) {
  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("project_id", PROJECT_ID);
  form.append("image", buffer, { filename, contentType: mimetype });

  return new Promise((resolve, reject) => {
    const https = require("https");
    const http = require("http");
    const url = new URL(`${CDN_BASE}?action=upload`);

    form.submit({
      protocol: url.protocol,
      host: url.hostname,
      path: url.pathname + url.search,
      headers: { "X-API-Key": API_KEY },
    }, (err, res) => {
      if (err) return reject(err);
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (!data.success) return reject(new Error(data.error || "CDN upload failed"));
          resolve(data.image);
        } catch (e) {
          reject(new Error(`CDN parse error: ${body.substring(0, 200)}`));
        }
      });
    });
  });
}

async function uploadFromDataUrl(dataUrl, filename) {
  const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!matches) throw new Error("Invalid data URL");
  const mimetype = matches[1];
  const base64 = matches[2];
  const buffer = Buffer.from(base64, "base64");
  return uploadImage(buffer, filename, mimetype);
}

async function deleteImage(id) {
  if (!/^\d+$/.test(String(id))) return false;
  const res = await fetch(`${CDN_BASE}?action=delete&id=${id}`, {
    method: "DELETE",
    headers: { "X-API-Key": API_KEY },
  });
  const data = await res.json();
  return data.success;
}

function getServeUrl(id, w, h, fit = "cover") {
  let url = `${CDN_BASE}?action=serve&id=${id}&fit=${fit}`;
  if (w) url += `&w=${w}`;
  if (h) url += `&h=${h}`;
  return url;
}

async function processImages(imagesJson) {
  if (!API_KEY) {
    console.warn("STARKCDN_API_KEY not set, skipping CDN upload");
    return imagesJson;
  }
  let images;
  try {
    images = typeof imagesJson === "string" ? JSON.parse(imagesJson || "[]") : (imagesJson || []);
  } catch { return imagesJson; }
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (img.src && img.src.startsWith("data:")) {
      try {
        const filename = img.name || `image-${Date.now()}-${i}.jpg`;
        const result = await uploadFromDataUrl(img.src, filename);
        images[i] = {
          id: String(result.id),
          src: result.url,
          name: result.original_name,
          cdn_id: result.id,
          width: result.width,
          height: result.height,
        };
        console.log(`CDN uploaded: ${filename} -> ${result.url}`);
      } catch (e) {
        console.error("CDN upload error:", e.message);
      }
    }
  }
  return JSON.stringify(images);
}

async function deleteNoteImages(imagesJson) {
  if (!API_KEY) return;
  let images;
  try {
    images = typeof imagesJson === "string" ? JSON.parse(imagesJson || "[]") : (imagesJson || []);
  } catch { return; }
  for (const img of images) {
    if (img.cdn_id) {
      try { await deleteImage(img.cdn_id); } catch {}
    }
  }
}

module.exports = { uploadImage, uploadFromDataUrl, deleteImage, getServeUrl, processImages, deleteNoteImages };
