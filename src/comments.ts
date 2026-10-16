import { Hono } from 'hono'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const app = new Hono()

/**
 * 1. POST /comments - Soumission d'un commentaire par un utilisateur
 * - Vérifie que les champs ne sont pas vides (ni espaces seuls)
 * - Vérifie que le contenu ne dépasse pas 500 caractères
 * - Statut défini par défaut à "pending" (en attente de modération)
 */
app.post('/comments', async (c) => {
  try {
    const body = await c.req.json()
    const { author, content } = body

    // Validation : Auteur obligatoire
    if (!author || typeof author !== 'string' || author.trim() === '') {
      return c.json({ error: "Le nom de l'auteur est obligatoire et ne peut pas être vide." }, 400)
    }

    // Validation : Contenu obligatoire
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return c.json({ error: "Le commentaire est obligatoire et ne peut pas être vide." }, 400)
    }

    // Validation : Limite de 500 caractères
    if (content.length > 500) {
      return c.json({ error: "Le commentaire ne doit pas dépasser 500 caractères." }, 400)
    }

    // Création dans la base de données
    const newComment = await prisma.comment.create({
      data: {
        author: author.trim(),
        content: content.trim(),
        status: 'pending', // En attente de validation admin
      },
    })

    return c.json({
      message: "Commentaire soumis avec succès. Il est en attente de validation.",
      comment: newComment,
    }, 201)

  } catch (error) {
    return c.json({ error: "Erreur serveur lors de l'enregistrement du commentaire." }, 500)
  }
})

/**
 * 2. GET /admin/comments - Récupérer tous les commentaires (pour l'admin)
 */
app.get('/admin/comments', async (c) => {
  try {
    const comments = await prisma.comment.findMany({
      orderBy: { createdAt: 'desc' },
    })
    return c.json(comments)
  } catch (error) {
    return c.json({ error: "Erreur lors de la récupération des commentaires." }, 500)
  }
})

/**
 * 3. PATCH /admin/comments/:id - Modifier un commentaire, son nom, ou son statut (Approuver/Rejeter)
 * L'administrateur peut modifier le statut ("approved" ou "pending"), le nom ou le contenu.
 */
app.patch('/admin/comments/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'))
    const body = await c.req.json()
    const { author, content, status } = body

    const updateData: any = {}

    // Validation et mise à jour du nom si fourni
    if (author !== undefined) {
      if (typeof author !== 'string' || author.trim() === '') {
        return c.json({ error: "Le nom ne peut pas être vide." }, 400)
      }
      updateData.author = author.trim()
    }

    // Validation et mise à jour du contenu si fourni
    if (content !== undefined) {
      if (typeof content !== 'string' || content.trim() === '') {
        return c.json({ error: "Le commentaire ne peut pas être vide." }, 400)
      }
      if (content.length > 500) {
        return c.json({ error: "Le commentaire ne doit pas dépasser 500 caractères." }, 400)
      }
      updateData.content = content.trim()
    }

    // Validation et mise à jour du statut (ex: passer de "pending" à "approved")
    if (status !== undefined) {
      if (!['pending', 'approved'].includes(status)) {
        return c.json({ error: "Statut invalide. Utilisez 'pending' ou 'approved'." }, 400)
      }
      updateData.status = status
    }

    const updatedComment = await prisma.comment.update({
      where: { id },
      data: updateData,
    })

    return c.json({
      message: "Commentaire mis à jour avec succès.",
      comment: updatedComment,
    })

  } catch (error) {
    return c.json({ error: "Commentaire introuvable ou erreur de mise à jour." }, 404)
  }
})

/**
 * 4. DELETE /admin/comments/:id - Supprimer un commentaire
 */
app.delete('/admin/comments/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'))

    await prisma.comment.delete({
      where: { id },
    })

    return c.json({ message: "Commentaire supprimé avec succès." })
  } catch (error) {
    return c.json({ error: "Commentaire introuvable ou erreur lors de la suppression." }, 404)
  }
})

export default app