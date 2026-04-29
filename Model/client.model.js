const mongoose = require("mongoose");
const collections = require("../config/collections");

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

module.exports =
  mongoose.models[collections.clients] ||
  mongoose.model(collections.clients, clientSchema, collections.clients);

