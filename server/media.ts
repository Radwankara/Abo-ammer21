import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { Client as ReplitObjectStorageClient } from "@replit/object-storage";
import { fileTypeFromBuffer } from "file-type";
import { Router, type Request, type RequestHandler } from "express";
import multer from "multer";
import { query } from "./db";
import { requireAdmin, requireUser } from "./auth";
import { ApiError } from "./errors";

const storage = new ReplitObjectStorageClient();
const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { files: 5, fileSize: 30 * 1024 * 1024 },
});

const supportedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const supportedVideoTypes = new Set(["video/mp4", "video/webm", "video/quicktime"]);

export async function deleteProductMediaObjects(productId: string) {
  const media = await query(
    "SELECT id, storage_key FROM product_media WHERE product_id = $1",
    [productId],
  );
  for (const item of media.rows) {
    const result = await storage.delete(item.storage_key, { ignoreNotFound: true });
    if (!result.ok) {
      throw new ApiError(502, "تعذر حذف ملف من مساحة التخزين؛ لم يتم حذف المنتج.");
    }
  }
}

async function deleteMediaObject(mediaId: string) {
  const media = await query(
    "SELECT id, storage_key FROM product_media WHERE id = $1",
    [mediaId],
  );
  if (!media.rowCount) throw new ApiError(404, "الملف غير موجود.");
  const result = await storage.delete(media.rows[0].storage_key, { ignoreNotFound: true });
  if (!result.ok) throw new ApiError(502, "تعذر حذف الملف من مساحة التخزين.");
  await query("DELETE FROM product_media WHERE id = $1", [mediaId]);
}

const handleProductUpload: RequestHandler = uploader.array("files", 5);

export const mediaRouter = Router();

mediaRouter.post(
  "/admin/products/:productId/media",
  requireUser,
  requireAdmin,
  handleProductUpload,
  async (req: Request, res, next) => {
    const files = (req.files || []) as Express.Multer.File[];
    const productId = String(req.params.productId);
    if (!files.length) {
      res.status(400).json({ error: "اختر صورة أو فيديو لرفعه." });
      return;
    }

    const product = await query("SELECT id FROM store_products WHERE id = $1", [productId]);
    if (!product.rowCount) {
      res.status(404).json({ error: "المنتج غير موجود." });
      return;
    }

    const uploadedKeys: string[] = [];
    try {
      const savedMedia = [];
      for (const file of files) {
        const detected = await fileTypeFromBuffer(file.buffer);
        if (!detected) throw new ApiError(400, "نوع أحد الملفات غير مدعوم.");
        const mediaType = supportedImageTypes.has(detected.mime)
          ? "image"
          : supportedVideoTypes.has(detected.mime)
            ? "video"
            : null;
        if (!mediaType) {
          throw new ApiError(400, "الأنواع المسموحة: JPG أو PNG أو WebP أو GIF، وفيديو MP4 أو WebM أو MOV.");
        }
        if (mediaType === "image" && file.size > 8 * 1024 * 1024) {
          throw new ApiError(413, "حجم الصورة الواحدة لا يزيد عن 8 ميجابايت.");
        }

        const mediaId = randomUUID();
        const objectKey = `products/${productId}/${mediaId}.${detected.ext}`;
        const uploadResult = await storage.uploadFromBytes(objectKey, file.buffer);
        if (!uploadResult.ok) throw new ApiError(502, "تعذر رفع الملف إلى مساحة التخزين.");
        uploadedKeys.push(objectKey);

        const safeName = basename(file.originalname || `media.${detected.ext}`)
          .replace(/[\u0000-\u001f\u007f]/g, "")
          .slice(0, 240) || `media.${detected.ext}`;
        const sortResult = await query(
          "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM product_media WHERE product_id = $1",
          [productId],
        );
        const inserted = await query(
          `INSERT INTO product_media (
            id, product_id, storage_key, media_type, mime_type,
            original_name, size_bytes, sort_order, uploaded_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING id, media_type, mime_type, original_name, sort_order`,
          [
            mediaId,
            productId,
            objectKey,
            mediaType,
            detected.mime,
            safeName,
            file.size,
            sortResult.rows[0].next,
            req.appUser!.clerkUserId,
          ],
        );
        const row = inserted.rows[0];
        savedMedia.push({
          id: row.id,
          mediaType: row.media_type,
          mimeType: row.mime_type,
          originalName: row.original_name,
          sortOrder: row.sort_order,
          url: `/api/media/${row.id}`,
        });
      }
      res.status(201).json({ media: savedMedia });
    } catch (error) {
      await Promise.all(
        uploadedKeys.map((key) => storage.delete(key, { ignoreNotFound: true })),
      );
      next(error);
    }
  },
);

mediaRouter.delete(
  "/admin/media/:mediaId",
  requireUser,
  requireAdmin,
  async (req, res, next) => {
    try {
      await deleteMediaObject(String(req.params.mediaId));
      res.json({ message: "تم حذف الملف." });
    } catch (error) {
      next(error);
    }
  },
);

mediaRouter.get("/media/:mediaId", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT m.storage_key, m.mime_type, m.original_name
       FROM product_media m
       JOIN store_products p ON p.id = m.product_id
       WHERE m.id = $1 AND p.is_active = TRUE`,
      [req.params.mediaId],
    );
    if (!result.rowCount) {
      res.status(404).json({ error: "الملف غير موجود." });
      return;
    }

    const download = await storage.downloadAsBytes(result.rows[0].storage_key);
    if (!download.ok) {
      res.status(502).json({ error: "تعذر تحميل الملف من مساحة التخزين." });
      return;
    }
    const [bytes] = download.value;
    res.setHeader("Content-Type", result.rows[0].mime_type);
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(result.rows[0].original_name)}"`);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(bytes);
  } catch (error) {
    next(error);
  }
});
