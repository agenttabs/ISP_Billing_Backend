require("dotenv").config();

const DATABASE_NAME = process.env.MONGO_DB_NAME || "isp_billing";
const MONGO_URI =
  process.env.MONGO_URI_LOCAL ||
  process.env.MONGO_URI ||
  "mongodb://192.168.8.138:27017/isp_billing";

const MONGOOSE_OPTIONS = {
  dbName: DATABASE_NAME,
  serverSelectionTimeoutMS: 5000
};

module.exports = {
  DATABASE_NAME,
  MONGO_URI,
  MONGOOSE_OPTIONS
};
