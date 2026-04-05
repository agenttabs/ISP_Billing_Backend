

const errorHandler = (err, req, res, next) => {
  console.error("❌ ERROR:", err.stack);

  res.status(500).json({
    message: err.message || "Server Error",
  });
};

module.exports = { errorHandler };