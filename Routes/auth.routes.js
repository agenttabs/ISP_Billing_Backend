const express = require("express");
const router = express.Router();

const {
  createUser,
  getUsers,
  getTechnicians,
  login,
  signup,
  me,
  updateUser,
  changeMyPassword
} = require("../controller/auth.controller");
const { authorize, protect } = require("../middleware/auth.middleware");


router.post("/login", login);

router.post("/signup", signup);
router.get("/me", protect, me);
router.post("/change-password", protect, changeMyPassword);
router.get("/users", protect, authorize("ADMIN"), getUsers);
router.get("/technicians", protect, authorize("ADMIN", "CASHIER"), getTechnicians);
router.post("/users", protect, authorize("ADMIN"), createUser);
router.put("/users/:id", protect, authorize("ADMIN"), updateUser);

module.exports = router;
