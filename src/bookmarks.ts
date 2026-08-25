import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { jwt, sign } from "hono/jwt";
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import bcrypt from "bcryptjs"; // Import de bcryptjs

const app = new Hono();
const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_change_me";
const UPLOAD_DIR = "./uploads";

// ------------------------------------------------------------------
// 🔑 CONFIGURATION DU MOT DE PASSE (BCRYPT)
// ------------------------------------------------------------------
// Si aucun hash n'est fourni dans le .env, on hache "saintcharles" par défaut
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync("saintcharles", 10);

// Créer le dossier d'uploads s'il n'existe pas
if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Servir les images enregistrées en accès public
app.use("/uploads/*", serveStatic({ root: "./" }));

// ------------------------------------------------------------------
// 1. CONNEXION (SÉCURISÉE AVEC BCRYPT)
// ------------------------------------------------------------------
app.post("/api/auth/login", async (c) => {
  const { password } = await c.req.json();

  if (!password) {
    return c.json({ error: "Le mot de passe est obligatoire" }, 400);
  }

  // 🔒 Bcrypt compare le mot de passe envoyé ("saintcharles") avec le hash en mémoire
  const isPasswordValid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

  if (!isPasswordValid) {
    return c.json({ error: "Mot de passe incorrect" }, 401);
  }

  // Génération du token JWT valide pendant 24 heures
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

// Middleware JWT sécurisé pour les routes protégées
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

  // Générer un nom de fichier unique
  const extension = file.name.split(".").pop();
  const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${extension}`;
  const filePath = join(UPLOAD_DIR, uniqueName);

  // Sauvegarder le fichier physiquement sur le serveur
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  writeFileSync(filePath, buffer);

  const imageUrl = `/uploads/${uniqueName}`;

  // Enregistrer les métadonnées de l'image dans la base de données SQLite
  const savedImage = await prisma.image.create({
    data: {
      title,
      fileName: uniqueName,
      url: imageUrl,
    },
  });

  return c.json({ message: "Image téléversée avec succès", image: savedImage }, 201);
});

// Démarrage du serveur Hono
serve({ fetch: app.fetch, port: 3000 }, (info) => {
  console.log(`Serveur démarré sur http://localhost:${info.port}`);
});