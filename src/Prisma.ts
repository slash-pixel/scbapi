import { PrismaClient } from '@prisma/client'

// Instance unique réutilisée dans toute l'app (évite d'ouvrir trop de connexions)
export const prisma = new PrismaClient()