const mongoose = require("mongoose");
const { DATABASE_NAME, MONGO_URI, MONGOOSE_OPTIONS } = require("./mongo");

const connectDB = async () => {
  try {
    await mongoose.connect(MONGO_URI, MONGOOSE_OPTIONS);

    console.log(`MongoDB Connected (${DATABASE_NAME}) via ${MONGO_URI}`);
  } catch (err) {
    console.error("DB CONNECTION ERROR:", err);
    process.exit(1);
  }
};

module.exports = connectDB;
