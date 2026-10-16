
require("dotenv").config();
const { Client } = require("pg");

async function main() {
  const connectionString = process.env.DIRECT_URL;

  if (!connectionString) {
    throw new Error("La variable DIRECT_URL est absente du fichier .env");
  }

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 15000,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const result = await client.query("SELECT NOW()");
    console.log("Connexion réussie :", result.rows[0]);
  } catch (error) {
    console.error("Échec de connexion :", error.message);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
