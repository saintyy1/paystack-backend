const { db } = require("../firebase")
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY

module.exports = async (req, res) => {
  const allowedOrigins = [
    process.env.ALLOWED_ORIGIN_1,
    process.env.ALLOWED_ORIGIN_2,
    process.env.ALLOWED_ORIGIN_3,
  ].filter(Boolean); // remove empty ones
  
  const origin = req.headers.origin

  // Set CORS headers
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  }

   // Always handle preflight first
  if (req.method === "OPTIONS") {
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.writeHead(204);
    res.end();
    return;
  }

  const route = new URL(req.url, `http://${req.headers.host}`).searchParams.get("route")

  // --- Initialize transaction ---
  if (req.method === "POST" && route === "initialize-transaction") {
    try {
      const { email, amount, planId, bookId, userId, callback_url } = req.body

      if (!email || !amount || !callback_url || !planId || !bookId || !userId) {
        return res.status(400).json({ error: "Missing required fields" })
      }

      const paystackResponse = await fetch("https://api.paystack.co/transaction/initialize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        },
        body: JSON.stringify({
          email,
          amount: amount * 100,
          currency: "NGN",
          metadata: { planId, bookId, userId },
          callback_url,
        }),
      })

      const paystackData = await paystackResponse.json()

      if (!paystackData.status) {
        return res.status(400).json({
          status: false,
          error: paystackData.message || "Failed to initialize transaction",
        })
      }

      const reference = paystackData.data.reference
      await db.collection("novels").doc(bookId).update({ reference })

      return res.status(200).json({
        status: true,
        authorization_url: paystackData.data.authorization_url,
        reference,
        callback_url,
      })
    } catch (err) {
      console.error("Payment initializing error:", err)
      return res.status(500).json({ status: false, error: "Internal Server Error" })
    }
  }

  // --- Verify payment ---
  else if (req.method === "POST" && route === "verify-payment") {
    try {
      const { reference } = req.body
      if (!reference) {
        return res.status(400).json({ status: false, message: "Missing payment reference" })
      }

      const paystackResponse = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      })

      const paystackData = await paystackResponse.json()

      if (!paystackData.status) {
        return res.status(400).json({ status: false, message: "Payment verification failed" })
      }

      if (paystackData.data.status === "success") {
        const { planId, bookId, userId } = paystackData.data.metadata || {}

        if (!bookId || !planId || !userId) {
          return res.status(400).json({ status: false, message: "Invalid metadata" })
        }

        const admin = require("firebase-admin")
        await db.collection("novels").doc(bookId).update({
          isPromoted: true,
          promotionStartDate: admin.firestore.FieldValue.serverTimestamp(),
          promotionPlan: planId,
          promotionEndDate: new Date(Date.now() + (planId === "1-month" ? 30 : 60) * 24 * 60 * 60 * 1000),
          promotionEndNotificationSent: false
        })

        await db.collection("payments").add({
          userId,
          bookId,
          planId,
          amount: paystackData.data.amount / 100,
          reference,
          status: "success",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })

        return res.status(200).json({ status: true, message: "Payment verified and novel promoted successfully" })
      }

      return res.status(400).json({ status: false, message: "Payment verification failed" })
    } catch (err) {
      console.error("Error verifying payment:", err)
      return res.status(500).json({ status: false, message: "Internal Server Error" })
    }
  }

  // --- Not Found ---
  else {
    res.status(404).json({ status: false, message: "Route not found" })
  }
}
