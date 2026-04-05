// const mongoose = require("mongoose");
// const fs = require("fs");

// // connect MongoDB
// async function connectMongo() {
//   await mongoose.connect("mongodb://192.168.8.251:27017/isp_billing");
//   console.log("✅ MongoDB Connected");
// }

// // schema
// const Client = mongoose.model("Client", {
//   accountName: String,
//   accountNumber: String,
//   clientName: String,
//   contactNumber: String,
//   plan: String,
//   amountDue: Number,
//   balance: Number,
//   dueDate: Date,
//   status: String,
//   paymentStatus: String,
//   createdAt: Date
// });

// // helper: clean number
// function parseAmount(val) {
//   if (!val) return 0;
//   return Number(val.replace(/,/g, ""));
// }

// // migrate
// async function migrate() {
//   await connectMongo();
// ////
//   const raw = fs.readFileSync("C:/Users/kitzibebe/Downloads/dbsys/client.json");
//   const data = JSON.parse(raw);

//   console.log(`📦 Found ${data.length} records`);

//   function parseDate(val) {
//   if (!val || val === "N/A") return null;

//   const date = new Date(val);

//   if (isNaN(date)) return null;

//   return date;
// }

// const formatted = data.map(row => ({
//   accountName: row.AccountName,
//   accountNumber: row.AccountNumber,
//   clientName: row.ClientName,
//   contactNumber: row.ContactNumber,
//   plan: row.NetPlan,
//   amountDue: parseAmount(row.AmountDue),
//   balance: parseAmount(row.Balance),
//   dueDate: parseDate(row.DueDate),      // ✅ FIXED
//   status: row.Status,
//   paymentStatus: row.PaymentStatus,
//   createdAt: parseDate(row.DateEntry)   // ✅ FIXED
// }));


//   await Client.deleteMany(); // optional reset
//   await Client.insertMany(formatted);

//   console.log("✅ Migration complete");

//   mongoose.connection.close();
// }

// migrate();

const mongoose = require("mongoose");
const fs = require("fs");
const Client = require("./client.model"); // ✅ use model

async function connectMongo() {
  await mongoose.connect("mongodb://192.168.8.251:27017/isp_billing");
  console.log("✅ MongoDB Connected");
}

function parseAmount(val) {
  if (!val) return 0;
  return Number(val.replace(/,/g, ""));
}

function parseDate(val) {
  if (!val || val === "N/A") return null;
  const date = new Date(val);
  return isNaN(date) ? null : date;
}

async function migrate() {
  await connectMongo();

  const raw = fs.readFileSync("C:/Users/kitzibebe/Downloads/dbsys/client.json");
  const data = JSON.parse(raw);

  const formatted = data.map(row => ({
    accountName: row.AccountName,
    accountNumber: row.AccountNumber,
    clientName: row.ClientName,
    contactNumber: row.ContactNumber,
    plan: row.NetPlan,
    amountDue: parseAmount(row.AmountDue),
    balance: parseAmount(row.Balance),
    dueDate: parseDate(row.DueDate),
    status: row.Status,
    paymentStatus: row.PaymentStatus,
    createdAt: parseDate(row.DateEntry)
  }));

  await Client.deleteMany();
  await Client.insertMany(formatted);

  console.log("✅ Migration complete");

  mongoose.connection.close();
}

migrate();