const User = require("../Model/test.schema");

// GET all users
exports.getUsers = async (req, res) => {
  const users = await User.find();
  res.json(users);
};

// CREATE user
exports.createUser = async (req, res) => {
  const user = await User.create(req.body);
  res.json(user);
};