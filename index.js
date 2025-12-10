require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const OpenAI = require('openai');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ParseAPI is running' });
});

// Parse single invoice
app.post('/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const base64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are an invoice parser for construction equipment rentals. Extract the following from this invoice and return ONLY valid JSON, no other text:

{
  "vendor": "company name",
  "invoiceNumber": "invoice number",
  "invoiceDate": "date",
  "dueDate": "due date if shown",
  "equipment": ["list of equipment items"],
  "rentalCharges": 0.00,
  "fees": {
    "delivery": 0.00,
    "pickup": 0.00,
    "fuel": 0.00,
    "environmental": 0.00,
    "damage_waiver": 0.00,
    "other": 0.00
  },
  "tax": 0.00,
  "total": 0.00,
  "feePercentage": 0.00,
  "highFees": false,
  "confidence": "high/medium/low"
}

Calculate feePercentage as (total fees / rentalCharges * 100). Set highFees to true if feePercentage > 25.`
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64}`
              }
            }
          ]
        }
      ],
      max_tokens: 1000
    });

    const content = response.choices[0].message.content;
    
    // Try to parse the JSON from the response
    let parsed;
    try {
      // Remove markdown code blocks if present
      const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      return res.status(500).json({ 
        error: 'Failed to parse invoice', 
        raw: content 
      });
    }

    res.json({
      success: true,
      data: parsed
    });

  } catch (error) {
    console.error('Parse error:', error);
    res.status(500).json({ 
      error: 'Failed to process invoice',
      message: error.message 
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`ParseAPI running on port ${PORT}`);
});