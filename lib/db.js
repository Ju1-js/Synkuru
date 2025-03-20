import postgres from "postgres";
import dotenv from "dotenv";
dotenv.config();

const user = process.env.DB_USER;
const password = encodeURIComponent(process.env.DB_PASSWORD);
const host = process.env.DB_HOST;
const port = process.env.DB_PORT;
const database = process.env.DB_NAME;

const connectionString = `postgresql://${user}:${password}@${host}:${port}/${database}`;

const sql = postgres(connectionString);

export default sql;
