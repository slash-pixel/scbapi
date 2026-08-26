import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { jwt, sign } from "hono/jwt";
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs"; // 👈 Ajout de unlinkSync
import { join } from "path";
import bcrypt from "bcryptjs";

const app = new Hono();

app.use("/*", cors({
  origin: "*", 
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

app.get("/", (c) => {
  return c.text("Bienvenue sur l'API de gestion d'images de Saint Charles ! 🚀");
});

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_change_me";
const UPLOAD_DIR = "./uploads";

const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync("saintcharles", 10);

if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.use("/uploads/*", serveStatic({
  root: "./",
  rewriteRequestPath: (path) => path
}));

// ------------------------------------------------------------------
// 1. CONNEXION (SÉCURISÉE AVEC BCRYPT)
// ------------------------------------------------------------------
app.post("/api/auth/login", async (c) => {
  const { password } = await c.req.json();

  if (!password) {
    return c.json({ error: "Le mot de passe est obligatoire" }, 400);
  }

  const isPasswordValid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

  if (!isPasswordValid) {
    return c.json({ error: "Mot de passe incorrect" }, 401);
  }

  const token = await sign(
    { role: "admin", exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 },
    JWT_SECRET,
    "HS256"
  );

  return c.json({
    message: "Connexion réussie",
    token,
  });
});

const authMiddleware = jwt({
  secret: JWT_SECRET,
  alg: "HS256",
});

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

// Téléverser une image (Protégé par le token JWT)
app.post("/api/images", authMiddleware, async (c) => {
  const body = await c.req.parseBody();
  const title = body["title"] as string;
  const file = body["image"] as File;

  if (!title || !file) {
    return c.json({ error: "Le titre et le fichier image sont requis" }, 400);
  }

  const extension = file.name.split(".").pop();
  const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${extension}`;
  const filePath = join(UPLOAD_DIR, uniqueName);

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  writeFileSync(filePath, buffer);

  const imageUrl = `/uploads/${uniqueName}`;

  const savedImage = await prisma.image.create({
    data: {
      title,
      fileName: uniqueName,
      url: imageUrl,
    },
  });

  return c.json({ message: "Image téléversée avec succès", image: savedImage }, 201);
});

// ------------------------------------------------------------------
// 👇 3. SUPPRESSION D'IMAGE (NOUVELLE ROUTE)
// ------------------------------------------------------------------// ------------------------------------------------------------------
// 3. SUPPRESSION D'IMAGE (NOUVELLE ROUTE)
// ------------------------------------------------------------------
app.delete("/api/images/:id", authMiddleware, async (c) => {
  const id = c.req.param("id"); // 'id' est un string

  try {
    // Étape 1 : Vérifier si l'image existe dans la base de données
    const image = await prisma.image.findUnique({
      where: { id: id }, // 👈 CORRECTION : on passe directement le string
    });

    if (!image) {
      return c.json({ error: "Image non trouvée dans la base de données" }, 404);
    }

    // Étape 2 : Supprimer le fichier physique du dossier "uploads"
    const filePath = join(UPLOAD_DIR, image.fileName);
    if (existsSync(filePath)) {
      unlinkSync(filePath); 
    }

    // Étape 3 : Supprimer l'entrée dans la base de données Prisma
    await prisma.image.delete({
      where: { id: id }, // 👈 CORRECTION : on passe directement le string
    });

    return c.json({ message: "Image supprimée avec succès" }, 200);
  } catch (error) {
    console.error("Erreur lors de la suppression de l'image :", error);
    return c.json({ error: "Une erreur est survenue lors de la suppression" }, 500);
  }
});