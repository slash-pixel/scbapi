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

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("La variable d'environnement JWT_SECRET est obligatoire dans le fichier .env");
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  throw new Error("La variable d'environnement ADMIN_PASSWORD est obligatoire dans le fichier .env");
}
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);

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
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

app.get("/", (c) => {
  return c.text("Bienvenue sur l'API de Saint Charles ! 🚀");
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
      { folder: "saint-charles" },
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
  const file = body["image"] as File;
  const title = (body["title"] as string) || null;

  if (!file) {
    return c.json({ error: "Le fichier image est requis" }, 400);
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const cloudinaryResult = await uploadToCloudinary(buffer);

    const savedImage = await prisma.image.create({
      data: {
        title: title || file.name,
        fileName: cloudinaryResult.public_id,
        url: cloudinaryResult.secure_url,
      },
    });

    return c.json({ message: "Image téléversée avec succès", image: savedImage }, 201);
  } catch (error) {
    console.error("Erreur d'upload :", error);
    return c.json({ error: "Erreur lors de l'envoi de l'image" }, 500);
  }
});

// Supprimer une image (Protégé)
app.delete("/api/images/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");

  try {
    const image = await prisma.image.findUnique({
      where: { id: id },
    });

    if (!image) {
      return c.json({ error: "Image non trouvée" }, 404);
    }

    if (image.fileName) {
      try {
        await cloudinary.uploader.destroy(image.fileName);
      } catch (cloudErr) {
        console.warn(`[Cloudinary] Impossible de détruire ${image.fileName}.`, cloudErr);
      }
    }

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
// 3. GESTION DES COMMENTAIRES (AVEC VALIDATION ET MODÉRATION)
// ------------------------------------------------------------------

// A. Récupérer uniquement les commentaires approuvés (Public)
app.get("/api/comments", async (c) => {
  try {
    const comments = await prisma.comment.findMany({
      where: { status: "approved" },
      orderBy: { createdAt: "desc" },
    });
    return c.json(comments);
  } catch (error) {
    return c.json({ error: "Erreur lors de la récupération des commentaires." }, 500);
  }
});

// B. Soumettre un commentaire (Public - statut par défaut "pending")
app.post("/api/comments", async (c) => {
  try {
    const body = await c.req.json();
    const { author, content } = body;

    // Validation stricte : Auteur obligatoire et non vide
    if (!author || typeof author !== "string" || author.trim() === "") {
      return c.json({ error: "Le nom de l'auteur est obligatoire et ne peut pas être vide." }, 400);
    }

    // Validation stricte : Contenu obligatoire et non vide
    if (!content || typeof content !== "string" || content.trim() === "") {
      return c.json({ error: "Le commentaire est obligatoire et ne peut pas être vide." }, 400);
    }

    // Validation stricte : Maximum 500 caractères
    if (content.length > 500) {
      return c.json({ error: "Le commentaire ne doit pas dépasser 500 caractères." }, 400);
    }

    const newComment = await prisma.comment.create({
      data: {
        author: author.trim(),
        content: content.trim(),
        status: "pending", // En attente de validation par l'admin
      },
    });

    return c.json({
      message: "Commentaire soumis avec succès. Il est en attente de modération.",
      comment: newComment,
    }, 201);

  } catch (error) {
    return c.json({ error: "Erreur serveur lors de l'enregistrement du commentaire." }, 500);
  }
});

// C. Récupérer TOUS les commentaires (y compris les "pending") - (Protégé Admin)
app.get("/api/admin/comments", authMiddleware, async (c) => {
  try {
    const comments = await prisma.comment.findMany({
      orderBy: { createdAt: "desc" },
    });
    return c.json(comments);
  } catch (error) {
    return c.json({ error: "Erreur lors de la récupération des commentaires." }, 500);
  }
});

// D. Modifier un commentaire, son nom ou son statut (Approuver/Rejeter) - (Protégé Admin)
app.patch("/api/admin/comments/:id", authMiddleware, async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    const body = await c.req.json();
    const { author, content, status } = body;

    const updateData: any = {};

    if (author !== undefined) {
      if (typeof author !== "string" || author.trim() === "") {
        return c.json({ error: "Le nom ne peut pas être vide." }, 400);
      }
      updateData.author = author.trim();
    }

    if (content !== undefined) {
      if (typeof content !== "string" || content.trim() === "") {
        return c.json({ error: "Le commentaire ne peut pas être vide." }, 400);
      }
      if (content.length > 500) {
        return c.json({ error: "Le commentaire ne doit pas dépasser 500 caractères." }, 400);
      }
      updateData.content = content.trim();
    }

    if (status !== undefined) {
      if (!["pending", "approved"].includes(status)) {
        return c.json({ error: "Statut invalide. Utilisez 'pending' ou 'approved'." }, 400);
      }
      updateData.status = status;
    }

    const updatedComment = await prisma.comment.update({
      where: { id },
      data: updateData,
    });

    return c.json({
      message: "Commentaire mis à jour avec succès.",
      comment: updatedComment,
    });

  } catch (error) {
    return c.json({ error: "Commentaire introuvable ou erreur de mise à jour." }, 404);
  }
});

// E. Supprimer un commentaire - (Protégé Admin)
app.delete("/api/admin/comments/:id", authMiddleware, async (c) => {
  try {
    const id = parseInt(c.req.param("id"));

    await prisma.comment.delete({
      where: { id },
    });

    return c.json({ message: "Commentaire supprimé avec succès." });
  } catch (error) {
    return c.json({ error: "Commentaire introuvable ou erreur lors de la suppression." }, 404);
  }
});

// ------------------------------------------------------------------
// 4. GESTION DES ÉVÉNEMENTS (AGENDA + TICKER)
// ------------------------------------------------------------------
const DISPLAY_MODES = ["AGENDA", "TICKER", "BOTH"];

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

// Valide et nettoie le corps d'une requête événement
const parseEventBody = (body: any, partial = false) => {
  const data: any = {};

  if (!partial || body.title !== undefined) {
    if (typeof body.title !== "string" || body.title.trim() === "") {
      return { error: "Le titre est obligatoire et ne peut pas être vide." };
    }
    if (body.title.length > 150) {
      return { error: "Le titre ne doit pas dépasser 150 caractères." };
    }
    data.title = body.title.trim();
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") {
      return { error: "Description invalide." };
    }
    data.description = body.description?.trim() || null;
  }

  if (!partial || body.eventDate !== undefined) {
    const date = new Date(body.eventDate);
    if (!body.eventDate || isNaN(date.getTime())) {
      return { error: "La date et l'heure de l'événement sont invalides." };
    }
    data.eventDate = date;
  }

  if (body.displayMode !== undefined) {
    if (!DISPLAY_MODES.includes(body.displayMode)) {
      return { error: "Mode d'affichage invalide. Utilisez AGENDA, TICKER ou BOTH." };
    }
    data.displayMode = body.displayMode;
  }

  return { data };
};

// A. Liste publique : ?mode=agenda|ticker  &  ?upcoming=true
app.get("/api/events", async (c) => {
  try {
    const mode = c.req.query("mode")?.toUpperCase();
    const where: any = {};

    if (mode === "AGENDA" || mode === "TICKER") {
      where.displayMode = { in: [mode, "BOTH"] };
    }
    if (c.req.query("upcoming") === "true") {
      where.eventDate = { gte: new Date() };
    }

    const events = await prisma.event.findMany({
      where,
      orderBy: { eventDate: "asc" },
    });
    return c.json(events);
  } catch (error) {
    return c.json({ error: "Erreur lors de la récupération des événements." }, 500);
  }
});

// B. Événements à venir (Public)
app.get("/api/events/upcoming", async (c) => {
  try {
    const events = await prisma.event.findMany({
      where: { eventDate: { gte: new Date() } },
      orderBy: { eventDate: "asc" },
    });
    return c.json(events);
  } catch (error) {
    return c.json({ error: "Erreur lors de la récupération des événements." }, 500);
  }
});

// C. Événements du bandeau défilant (Public)
// On part du début de la journée pour qu'un événement du jour reste visible jusqu'au soir
app.get("/api/events/ticker", async (c) => {
  try {
    const events = await prisma.event.findMany({
      where: {
        displayMode: { in: ["TICKER", "BOTH"] },
        eventDate: { gte: startOfToday() },
      },
      orderBy: { eventDate: "asc" },
      take: 20,
    });
    return c.json(events);
  } catch (error) {
    return c.json({ error: "Erreur lors de la récupération du bandeau." }, 500);
  }
});

// D. Créer un événement (Protégé Admin)
app.post("/api/events", authMiddleware, async (c) => {
  try {
    const body = await c.req.json();
    const { data, error } = parseEventBody(body);
    if (error) return c.json({ error }, 400);

    const event = await prisma.event.create({ data });
    return c.json({ message: "Événement créé avec succès.", event }, 201);
  } catch (error) {
    return c.json({ error: "Erreur serveur lors de la création de l'événement." }, 500);
  }
});

// E. Modifier un événement (Protégé Admin)
app.put("/api/events/:id", authMiddleware, async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const { data, error } = parseEventBody(body, true);
    if (error) return c.json({ error }, 400);

    const event = await prisma.event.update({ where: { id }, data });
    return c.json({ message: "Événement mis à jour avec succès.", event });
  } catch (error) {
    return c.json({ error: "Événement introuvable ou erreur de mise à jour." }, 404);
  }
});

// F. Supprimer un événement (Protégé Admin)
app.delete("/api/events/:id", authMiddleware, async (c) => {
  try {
    await prisma.event.delete({ where: { id: c.req.param("id") } });
    return c.json({ message: "Événement supprimé avec succès." });
  } catch (error) {
    return c.json({ error: "Événement introuvable ou erreur lors de la suppression." }, 404);
  }
});

// ------------------------------------------------------------------
// 5. DÉMARRAGE DU SERVEUR
// ------------------------------------------------------------------
const port = Number(process.env.PORT) || 3000;

serve(
  { fetch: app.fetch, port },
  (info) => {
    console.log(`Serveur démarré sur le port ${info.port} 🚀`);
  }
);