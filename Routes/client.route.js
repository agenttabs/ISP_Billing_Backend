const express = require("express");
const router = express.Router();

const controller = require("../controller/client.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// test
router.get("/", controller.testAPI);

// clients
router.get(
  "/clients",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.getClients
);
router.get(
  "/clients/:id/mikrotik-status",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.getClientMikrotikStatus
);
router.get(
  "/clients/:id",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.getClientById
);
router.post(
  "/clients",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.createClient
);
router.put(
  "/clients/:id",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.updateClient
);
router.put(
  "/clients/:id/due-date",
  protect,
  authorize("ADMIN"),
  controller.adjustClientDueDate
);
router.post(
  "/clients/:id/repair",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.createRepairRequest
);

// netplans
router.get(
  "/netplans",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.getNetPlans
);
router.get(
  "/dhcp-leases",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.getDhcpLeases
);
router.get(
  "/dhcp-leases-all",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.getDhcpLeasesAll
);


router.get("/test-mikrotik", protect, authorize("ADMIN"), async (req, res) => {
  try {
    const { getMikrotikConfig } = require("../services/mikrotik");

    const server = await getMikrotikConfig("CCR2116");

    res.json(server);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
module.exports = router;

