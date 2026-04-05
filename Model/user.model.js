const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  username: String,
  password: String,

  role: {
    type: String,
    enum: ["admin", "user", "installer"],
    default: "user",
  },
});

module.exports = mongoose.model("User", userSchema);