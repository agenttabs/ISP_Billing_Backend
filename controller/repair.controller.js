const mongoose = require("mongoose");
const collections = require("../config/collections");

const getRepairCollection = () => mongoose.connection.db.collection(collections.repairs);

const getUser = (req) => ({
  name: String(req.user?.name || req.user?.Name || "").trim(),
  username: String(req.user?.username || req.user?.Username || "").trim(),
  type: String(req.user?.type || req.user?.role || req.user?.Type || "").trim().toUpperCase()
});

exports.getRepairs = async (req, res) => {
  try {
    const user = getUser(req);
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "ALL").trim().toUpperCase();
    const filter = {};

    if (user.type !== "ADMIN") {
      filter.status = "PENDING";
    } else if (status !== "ALL") {
      filter.status = status;
    }

    if (user.type === "TECHNICIAN") {
      filter.$or = [
        { technicianUsername: user.username },
        { technicianName: user.name }
      ].filter((item) => Object.values(item)[0]);
    }

    if (search) {
      const searchFilter = [
        { accountName: { $regex: search, $options: "i" } },
        { clientName: { $regex: search, $options: "i" } },
        { accountNumber: { $regex: search, $options: "i" } },
        { contactNumber: { $regex: search, $options: "i" } },
        { address: { $regex: search, $options: "i" } },
        { technicianName: { $regex: search, $options: "i" } },
        { repairText: { $regex: search, $options: "i" } },
        { repairDetails: { $regex: search, $options: "i" } }
      ];

      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchFilter }];
        delete filter.$or;
      } else {
        filter.$or = searchFilter;
      }
    }

    const rows = await getRepairCollection()
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.json(rows);
  } catch (err) {
    console.error("REPAIR STATUS UPDATE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.updateRepairStatus = async (req, res) => {
  try {
    const user = getUser(req);
    const id = String(req.params.id || "").trim();
    const status = String(req.body.status || "").trim().toUpperCase();

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid repair id." });
    }

    if (status !== "DONE") {
      return res.status(400).json({ error: "Only Done status is allowed from this action." });
    }

    const repair = await getRepairCollection().findOne({ _id: new mongoose.Types.ObjectId(id) });
    if (!repair) {
      return res.status(404).json({ error: "Repair record not found." });
    }

    if (user.type === "TECHNICIAN") {
      const assignedRows = repair.repairGroupId
        ? await getRepairCollection().find({ repairGroupId: repair.repairGroupId }).toArray()
        : [repair];
      const assignedToUser = assignedRows.some(
        (row) =>
          String(row.technicianUsername || "").trim().toLowerCase() === user.username.toLowerCase() ||
          String(row.technicianName || "").trim().toLowerCase() === user.name.toLowerCase()
      );

      if (!assignedToUser) {
        return res.status(403).json({ error: "You can only complete repairs assigned to you." });
      }
    }

    const updateFilter =
      repair.repairGroupId
        ? { repairGroupId: repair.repairGroupId }
        : { _id: new mongoose.Types.ObjectId(id) };

    await getRepairCollection().updateMany(
      updateFilter,
      {
        $set: {
          status: "DONE",
          statusChangedAt: new Date(),
          statusChangedBy: {
            name: user.name,
            username: user.username,
            type: user.type
          },
          updatedAt: new Date()
        }
      }
    );

    const saved = await getRepairCollection().findOne({ _id: new mongoose.Types.ObjectId(id) });
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
