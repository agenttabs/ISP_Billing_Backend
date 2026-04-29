const express = require("express");
const router = express.Router();

const controller = require("../controller/nap.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

router.get(
  "/nap",
  protect,
  authorize("ADMIN", "TECHNICIAN"),
  controller.getNapList
);

router.post(
  "/nap",
  protect,
  authorize("ADMIN", "TECHNICIAN"),
  controller.createNap
);

router.put(
  "/nap/:id",
  protect,
  authorize("ADMIN", "TECHNICIAN"),
  controller.updateNap
);

router.delete(
  "/nap/:id",
  protect,
  authorize("ADMIN"),
  controller.deleteNap
);

module.exports = router;
