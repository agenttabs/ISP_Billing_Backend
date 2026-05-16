const express = require("express");

const controller = require("../controller/client-bypass.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/client-bypass",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.getClientBypassList
);

router.get(
  "/client-bypass/clients",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.getClientBypassClients
);

router.post(
  "/client-bypass",
  protect,
  authorize("ADMIN"),
  controller.createClientBypass
);

router.delete(
  "/client-bypass/:id",
  protect,
  authorize("ADMIN"),
  controller.deleteClientBypass
);

module.exports = router;
