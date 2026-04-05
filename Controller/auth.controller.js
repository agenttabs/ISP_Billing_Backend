const User = require("../Model/user.model");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// SIGNUP
exports.signup = async (req, res) => {
  try {
    const { username, password, role } = req.body;

    const hashed = await bcrypt.hash(password, 10);

    const user = await User.create({
      username,
      password: hashed,
      role: role || "user", // default client
    });

    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await User.findOne({ username });

    if (!user) return res.status(401).json({ error: "User not found" });

    const match = await bcrypt.compare(password, user.password);

    if (!match) return res.status(401).json({ error: "Invalid password" });

    const token = jwt.sign(
      {
        id: user._id,
        role: user.role, 
      },
      "SECRET_KEY",
      { expiresIn: "1d" }
    );

    res.json({
      token,
      role: user.role,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};