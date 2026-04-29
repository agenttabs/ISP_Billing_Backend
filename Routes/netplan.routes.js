const express = require("express");
const router = express.Router();

const controller = require("../controller/netplan.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

router.post(
  "/netplans",
  protect,
  authorize("ADMIN"),
  controller.createNetPlan
);

router.put(
  "/netplans/:id",
  protect,
  authorize("ADMIN"),
  controller.updateNetPlan
);

router.delete(
  "/netplans/:id",
  protect,
  authorize("ADMIN"),
  controller.deleteNetPlan
);

module.exports = router;
