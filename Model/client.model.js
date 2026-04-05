const mongoose = require("mongoose");

const clientSchema = new mongoose.Schema({
  accountName: String,
  accountNumber: String,
  clientName: String,
  contactNumber: String,
  plan: String,
  amountDue: Number,
  balance: Number,
  dueDate: Date,
  status: String,
  paymentStatus: String,
  createdAt: Date
});

module.exports = mongoose.model("clients", clientSchema);

