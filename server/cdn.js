const CDN_BASE = "https://cdn.starkbilisim.com/api/api.php";
const API_KEY = process.env.STARKCDN_API_KEY || "";
const PROJECT_ID = process.env.STARKCDN_PROJECT_ID || "1";

async function uploadImage(buffer, filename, mimetype) {
  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("project_id", PROJECT_ID);
  form.append("image", buffer, { filename, contentType: mimetype });

  const res = await fetch(`${CDN_BASE}?action=upload`, {
    method: "POST",
    headers: { "X-API-Key": API_KEY, ...form.getHeaders() },
    body: form,
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "CDN upload failed");
  return data.image;
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
  if (!API_KEY) return imagesJson;
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
