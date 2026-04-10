const express = require("express");
const multer = require("multer");

const { uploadCsv } = require("../controllers/uploadController");

const router = express.Router();

// Store files in memory; we parse immediately and keep the dataset in memory.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB CSV limit for hackathon demo safety
  },
});

router.post("/", upload.single("file"), uploadCsv);

module.exports = router;

