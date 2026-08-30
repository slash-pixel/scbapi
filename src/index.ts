import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { jwt, sign } from "hono/jwt";
import { PrismaClient } from "@prisma/client";
import { v2 as cloudinary } from "cloudinary";
import bcrypt from "bcryptjs";

// ------------------------------------------------------------------
// CONFIGURATIONS
// ------------------------------------------------------------------
const app = new Hono();
const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_change_me";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync("saintcharles", 10);

// Configuration Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

app.get("/", (c) => {
  return c.text("Bienvenue sur l'API de gestion d'images de Saint Charles ! 🚀");
});

// ------------------------------------------------------------------
// 1. CONNEXION (SÉCURISÉE AVEC BCRYPT)
// ------------------------------------------------------------------
app.post("/api/auth/login", async (c) => {
  const { password } = await c.req.json();

  if (!password) return c.json({ error: "Le mot de passe est obligatoire" }, 400);

  const isPasswordValid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

  if (!isPasswordValid) return c.json({ error: "Mot de passe incorrect" }, 401);

  // Le token expire dans 24h
  const token = await sign(
    { role: "admin", exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 },
    JWT_SECRET,
    "HS256"
  );

  return c.json({ message: "Connexion réussie", token });
});

const authMiddleware = jwt({
  secret: JWT_SECRET,
  alg: "HS256",
});

// Fonction utilitaire pour uploader un buffer vers Cloudinary via un stream
const uploadToCloudinary = (buffer: Buffer): Promise<any> => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "saint-charles" }, // Crée un dossier propre dans ton Cloudinary
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
};

// ------------------------------------------------------------------
// 2. GESTION DES IMAGES
// ------------------------------------------------------------------

// Récupérer toutes les images (Public)
app.get("/api/images", async (c) => {
  const images = await prisma.image.findMany({
    orderBy: { createdAt: "desc" },
  });
  return c.json(images);
});

// Téléverser une image vers Cloudinary (Protégé)
app.post("/api/images", authMiddleware, async (c) => {
  const body = await c.req.parseBody();
  const title = body["title"] as string;
  const file = body["image"] as File;

  if (!title || !file) {
    return c.json({ error: "Le titre et le fichier image sont requis" }, 400);
  }

  try {
    // 1. Convertir le fichier en Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 2. Envoyer directement à Cloudinary
    const cloudinaryResult = await uploadToCloudinary(buffer);

    // 3. Sauvegarder dans Neon PostgreSQL via Prisma
    const savedImage = await prisma.image.create({
      data: {
        title,
        fileName: cloudinaryResult.public_id, // Identifiant unique Cloudinary
        url: cloudinaryResult.secure_url,     // Lien HTTPS direct vers Cloudinary
      },
    });

    return c.json({ message: "Image téléversée avec succès", image: savedImage }, 201);
  } catch (error) {
    console.error("Erreur d'upload :", error);
    return c.json({ error: "Erreur lors de l'envoi de l'image" }, 500);
  }
});

// ------------------------------------------------------------------
// 3. SUPPRESSION D'IMAGE (SÉCURISÉE & SANS BLOCAGE)
// ------------------------------------------------------------------
app.delete("/api/images/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");

  try {
    const image = await prisma.image.findUnique({
      where: { id: id },
    });

    if (!image) {
      return c.json({ error: "Image non trouvée" }, 404);
    }

    // 1. Essayer de supprimer sur Cloudinary si un identifiant existe
    if (image.fileName) {
      try {
        await cloudinary.uploader.destroy(image.fileName);
      } catch (cloudErr) {
        console.warn(`[Cloudinary] Impossible de détruire ${image.fileName}, poursuite de la suppression en BDD.`, cloudErr);
      }
    }

    // 2. Supprimer la ligne dans la base de données Neon via Prisma
    await prisma.image.delete({
      where: { id: id },
    });

    return c.json({ message: "Image supprimée avec succès" }, 200);
  } catch (error) {
    console.error("Erreur lors de la suppression :", error);
    return c.json({ error: "Une erreur est survenue lors de la suppression" }, 500);
  }
});

// ------------------------------------------------------------------
// 4. DÉMARRAGE DU SERVEUR
// ------------------------------------------------------------------
const port = Number(process.env.PORT) || 3000;

serve(
  { fetch: app.fetch, port },
  (info) => {
    console.log(`Serveur démarré sur le port ${info.port} 🚀`);
  }
);