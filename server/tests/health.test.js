const request = require("supertest");
const app = require("../server");

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await request(app).get("/health");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, service: "dataspeak-server" });
  });
});

