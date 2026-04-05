const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    await mongoose.connect("mongodb://192.168.8.251:27017/isp_billing", {
      serverSelectionTimeoutMS: 5000,
    });

    console.log("✅ MongoDB Connected");
  } catch (err) {
    console.error("❌ DB CONNECTION ERROR:", err);
    process.exit(1);
  }
};

module.exports = connectDB;