require("dotenv").config()
const http = require("http")
const { db } = require("./firebase")
const allowedOrigins = process.env.ALLOWED_ORIGIN

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY

// Function to handle HTTP requests
const requestHandler = async (req, res) => {
  const origin = req.headers.origin

  // Set CORS headers
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  }

  // Handle preflight request (OPTIONS)
  if (req.method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  } else if (req.method === "POST" && req.url.match("/api/initialize-transaction")) {
    let body = ""

    req.on("data", (chunk) => {
      body += chunk.toString()
    })

    req.on("end", async () => {
      try {
        const { email, amount, planId, bookId, userId, callback_url } = JSON.parse(body)

        if (!email || !amount || !callback_url || !planId || !bookId || !userId) {
          res.writeHead(400, { "Content-Type": "application/json" })
          return res.end(JSON.stringify({ error: "Missing required fields" }))
        }

        // Initialize transaction with Paystack
        const paystackResponse = await fetch("https://api.paystack.co/transaction/initialize", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          },
          body: JSON.stringify({
            email,
            amount: amount * 100, // Paystack expects amount in kobo
            currency: "NGN",
            metadata: {
              planId,
              bookId,
              userId,
            },
            callback_url,
          }),
        })

        const paystackData = await paystackResponse.json()

        if (!paystackData.status) {
          res.writeHead(400, { "Content-Type": "application/json" })
          return res.end(
            JSON.stringify({
              status: false,
              error: paystackData.message || "Failed to initialize transaction",
            }),
          )
        }

        const reference = paystackData.data.reference

        // Save reference in Firestore
        await db.collection("novels").doc(bookId).update({ reference })

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            status: true,
            authorization_url: paystackData.data.authorization_url,
            reference,
            callback_url, // Send back modified callback URL
          }),
        )
      } catch (error) {
        console.error("Payment initializing error:", error)
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ status: false, error: "Internal Server Error" }))
      }
    })
  } else if (req.method === "POST" && req.url === "/api/verify-payment") {
    let body = ""

    req.on("data", (chunk) => {
      body += chunk.toString()
    })

    req.on("end", async () => {
      try {
        const { reference } = JSON.parse(body)

        if (!reference) {
          res.writeHead(400, { "Content-Type": "application/json" })
          return res.end(JSON.stringify({ status: false, message: "Missing payment reference" }))
        }

        // Step 1: Verify payment with Paystack
        const paystackResponse = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
        })

        const paystackData = await paystackResponse.json()

        if (!paystackData.status) {
          res.writeHead(400, { "Content-Type": "application/json" })
          return res.end(JSON.stringify({ status: false, message: "Payment verification failed" }))
        }

        if (paystackData.data.status === "success") {
          const metadata = paystackData.data.metadata

          // Validate that metadata exists and contains required fields
          if (!metadata) {
            res.writeHead(400, { "Content-Type": "application/json" })
            return res.end(
              JSON.stringify({
                status: false,
                message: "Payment metadata is missing",
              }),
            )
          }

          const { planId, bookId, userId } = metadata

          // Validate each required field individually
          if (!bookId || typeof bookId !== "string" || bookId.trim() === "") {
            console.error("Invalid bookId:", bookId)
            res.writeHead(400, { "Content-Type": "application/json" })
            return res.end(
              JSON.stringify({
                status: false,
                message: "Invalid or missing bookId in payment metadata",
              }),
            )
          }

          if (!planId || typeof planId !== "string" || planId.trim() === "") {
            console.error("Invalid planId:", planId)
            res.writeHead(400, { "Content-Type": "application/json" })
            return res.end(
              JSON.stringify({
                status: false,
                message: "Invalid or missing planId in payment metadata",
              }),
            )
          }

          if (!userId || typeof userId !== "string" || userId.trim() === "") {
            console.error("Invalid userId:", userId)
            res.writeHead(400, { "Content-Type": "application/json" })
            return res.end(
              JSON.stringify({
                status: false,
                message: "Invalid or missing userId in payment metadata",
              }),
            )
          }

          try {
            const bookDoc = await db.collection("novels").doc(bookId.trim()).get()
            if (!bookDoc.exists) {
              res.writeHead(404, { "Content-Type": "application/json" })
              return res.end(
                JSON.stringify({
                  status: false,
                  message: `Book with ID ${bookId} not found in database`,
                }),
              )
            }

            const admin = require("firebase-admin")

            await db
              .collection("novels")
              .doc(bookId.trim())
              .update({
                isPromoted: true,
                promotionStartDate: admin.firestore.FieldValue.serverTimestamp(),
                promotionPlan: planId.trim(),
                promotionEndDate: new Date(Date.now() + (planId.trim() === "1-month" ? 30 : 60) * 24 * 60 * 60 * 1000),
              })

            await db.collection("payments").add({
              userId: userId.trim(),
              bookId: bookId.trim(),
              planId: planId.trim(),
              amount: paystackData.data.amount / 100, // Convert from kobo to naira
              reference,
              status: "success",
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            })

            res.writeHead(200, { "Content-Type": "application/json" })
            return res.end(
              JSON.stringify({ status: true, message: "Payment verified and novel promoted successfully" }),
            )
          } catch (firestoreError) {
            console.error("Firestore operation error:", firestoreError)
            res.writeHead(500, { "Content-Type": "application/json" })
            return res.end(
              JSON.stringify({
                status: false,
                message: "Database operation failed. Please contact support.",
              }),
            )
          }
        } else {
          res.writeHead(400, { "Content-Type": "application/json" })
          return res.end(JSON.stringify({ status: false, message: "Payment verification failed" }))
        }
      } catch (error) {
        console.error("Error verifying payment:", error)
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ status: false, message: "Internal Server Error" }))
      }
    })
  } else {
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ status: false, message: "Route not found" }))
  }
}

// Create the HTTP server
const server = http.createServer(requestHandler)

const PORT = process.env.PORT || 5000
server.listen(PORT, () => console.log(`Server running on port ${PORT}`))
