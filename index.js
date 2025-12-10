require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const OpenAI = require('openai');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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

// Save to Supabase
const feesTotal = parsed.fees ? Object.values(parsed.fees).reduce((sum, f) => sum + (f || 0), 0) : 0;
const feePercentage = parsed.rental_subtotal > 0 ? (feesTotal / parsed.rental_subtotal) * 100 : 0;

// Determine if equipment rental
const rentalKeywords = ['herc', 'sunbelt', 'united rentals', 'ohio cat', 'admar', 'skyworks', 'caterpillar', 'rental'];
const vendorLower = (parsed.vendor || '').toLowerCase();
const isRental = rentalKeywords.some(kw => vendorLower.includes(kw));

await supabase.from('parsed_invoices').insert({
  source: 'parseapi',
  invoice_type: isRental ? 'equipment_rental' : 'unknown',
  is_equipment_rental: isRental,
  vendor_name: parsed.vendor,
  vendor_normalized: vendorLower.split(' ')[0],
  invoice_number: parsed.invoice_number,
  invoice_date: parsed.invoice_date,
  po_number: parsed.po_number,
  customer_name: parsed.customer_name,
  job_site: parsed.job_site,
  rental_subtotal: parsed.rental_subtotal,
  fees_total: feesTotal,
  tax: parsed.tax,
  total: parsed.total,
  fees: parsed.fees,
  equipment: parsed.equipment,
  fee_percentage: feePercentage,
  confidence: parsed.confidence,
  raw_response: parsed
});

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

// Parse invoice from base64 (for Rate Daddy)
app.post('/parse-base64', async (req, res) => {
    try {
      const { base64Image, mimeType } = req.body;
  
      if (!base64Image) {
        return res.status(400).json({ error: 'No image provided' });
      }
  
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are an invoice parser for construction equipment rentals. Extract the following data from this invoice image and return ONLY valid JSON, no other text.
  
  {
    "vendor": "Company name",
    "invoice_number": "Invoice number",
    "invoice_date": "YYYY-MM-DD format",
    "po_number": "PO number or null",
    "customer_name": "Customer/Bill to name",
    "job_site": "Job site address or null",
    "equipment": [
      {
        "description": "Equipment description",
        "serial_number": "Serial number or null",
        "day_rate": 0.00,
        "week_rate": 0.00,
        "four_week_rate": 0.00,
        "amount": 0.00
      }
    ],
    "rental_subtotal": 0.00,
    "fees": {
      "delivery": 0.00,
      "pickup": 0.00,
      "environmental": 0.00,
      "fuel_surcharge": 0.00,
      "damage_waiver": 0.00,
      "transport_surcharge": 0.00,
      "other_fees": 0.00
    },
    "fees_total": 0.00,
    "tax": 0.00,
    "total": 0.00,
    "confidence": "high"
  }
  
  Set confidence to "high" if all fields are clearly readable, "medium" if some fields are unclear, "low" if significant parts are unreadable.
  
  Return ONLY the JSON object, no markdown, no explanation.`
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType || 'image/png'};base64,${base64Image}`
                }
              }
            ]
          }
        ],
        max_tokens: 2000
      });
  
      const content = response.choices[0].message.content;
  
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          return res.status(500).json({ 
            success: false,
            error: 'Could not parse OpenAI response as JSON' 
          });
        }
      }
  
      res.json({
        success: true,
        data: parsed,
        raw_response: content
      });
  
    } catch (error) {
      console.error('Parse error:', error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`ParseAPI running on port ${PORT}`);
});