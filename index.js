require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '50mb' }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function calculateExpectedAmount(dayRate, weekRate, fourWeekRate, rentalDays) {
  const day = parseFloat(dayRate) || 0;
  const week = parseFloat(weekRate) || 0;
  const month = parseFloat(fourWeekRate) || 0;
  const days = parseInt(rentalDays) || 1;
  
  if (day === 0 && week === 0 && month === 0) {
    return 0;
  }
  
  const effectiveDay = day || (week / 5) || (month / 20);
  const effectiveWeek = week || (day * 5) || (month / 4);
  const effectiveMonth = month || (week * 4) || (day * 20);
  
  if (days <= 2) {
    return effectiveDay * days;
  } else if (days <= 6) {
    return Math.min(effectiveDay * days, effectiveWeek);
  } else if (days <= 27) {
    return Math.min(
      effectiveDay * days,
      effectiveWeek * Math.ceil(days / 7),
      effectiveMonth
    );
  } else {
    return Math.min(
      effectiveMonth * Math.ceil(days / 28),
      effectiveWeek * Math.ceil(days / 7)
    );
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'ParseAPI is running' });
});

app.get('/test-db', async (req, res) => {
  try {
    console.log('[/test-db] hit');
    const { data, error } = await supabase
      .from('parsed_invoices')
      .insert({
        source: 'parseapi',
        app_source: 'test',
        vendor_name: 'Test Vendor',
        invoice_number: 'TEST-123',
        total: 100
      });
    console.log('[/test-db] data:', data);
    console.log('[/test-db] error:', error);
    if (error) {
      return res.status(500).json({ success: false, error });
    }
    res.json({ success: true, data });
  } catch (err) {
    console.error('[/test-db] exception:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

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
  "invoice_number": "invoice number",
  "invoice_date": "YYYY-MM-DD",
  "po_number": "PO number or null",
  "customer_name": "customer name",
  "job_site": "job site or null",
  "equipment": [],
  "rental_subtotal": 0.00,
  "fees": {},
  "tax": 0.00,
  "total": 0.00,
  "confidence": "high/medium/low"
}`
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
    let parsed;
    try {
      const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse invoice', raw: content });
    }
    res.json({ success: true, data: parsed });
  } catch (error) {
    console.error('Parse error:', error);
    res.status(500).json({ error: 'Failed to process invoice', message: error.message });
  }
});

app.post('/parse-base64', async (req, res) => {
  try {
    const { base64Image, mimeType, userId } = req.body;
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
              text: `You are an invoice parser for construction equipment rentals. Extract data from this invoice and return ONLY valid JSON.

CRITICAL RULES FOR FEES:
1. NEVER count Delivery or Pickup as a fee - these are legitimate services
2. NEVER double-count: If you see "Other Charges" as a subtotal, DO NOT also add the individual line items that make up that subtotal
3. Only count these as fees:
   - Trans Srvc Surcharge / Transportation Surcharge
   - Emissions & Env Surcharge / Environmental fee
   - Fuel surcharge (NOT fuel/propane refill - that's a service)
   - Admin fee
   - Rental Protection / Damage Waiver / LDW
   - Shop supplies fee
   - Any line with "surcharge" or "fee" in the name (EXCEPT delivery/pickup fees)

WHAT IS NOT A FEE (put in delivery_pickup_total, not fees):
- Delivery charge / Delivery
- Pickup charge / Pick up
- Freight / Hauling
- Any delivery/pickup related charge

FOR FEES TOTAL:
- Add up ONLY the individual fee line items (surcharges, environmental, etc)
- Do NOT use "Other Charges" if it's a subtotal of fees you already counted
- If you can only see "Other Charges" as a lump sum without itemized fees above it, then use that

FOR RENTAL_SUBTOTAL:
- Use "RENTAL CHARGES" from the summary box if available
- This is the equipment rental amount BEFORE fees, delivery, and tax

FOR EQUIPMENT: Extract day_rate, week_rate, four_week_rate if shown. Also extract rental_days from dates or billing period.

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
      "rental_days": 1,
      "amount": 0.00
    }
  ],
  "rental_subtotal": 0.00,
  "delivery_pickup_total": 0.00,
  "fees": {
    "transport_surcharge": 0.00,
    "environmental": 0.00,
    "fuel_surcharge": 0.00,
    "rental_protection": 0.00,
    "admin_fee": 0.00,
    "other": 0.00
  },
  "tax": 0.00,
  "total": 0.00,
  "confidence": "high"
}

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
        return res.status(500).json({ success: false, error: 'Could not parse OpenAI response as JSON' });
      }
    }
    
    const feesTotal = parsed.fees ? Object.values(parsed.fees).reduce((sum, f) => sum + (parseFloat(f) || 0), 0) : 0;
    const rentalSubtotal = parseFloat(parsed.rental_subtotal) || 0;
    const feePercentage = rentalSubtotal > 0 ? (feesTotal / rentalSubtotal) * 100 : 0;
    
    const rentalKeywords = ['herc', 'sunbelt', 'united rentals', 'ohio cat', 'admar', 'skyworks', 'caterpillar', 'rental'];
    const vendorLower = (parsed.vendor || '').toLowerCase();
    const isRental = rentalKeywords.some(kw => vendorLower.includes(kw));
    
    const { data: insertData, error: insertError } = await supabase.from('parsed_invoices').insert({
      source: 'parseapi',
      app_source: 'rate_daddy',
      user_id: userId || null,
      invoice_type: isRental ? 'equipment_rental' : 'unknown',
      is_equipment_rental: isRental,
      vendor_name: parsed.vendor || null,
      vendor_normalized: vendorLower.split(' ')[0] || null,
      invoice_number: parsed.invoice_number || null,
      invoice_date: parsed.invoice_date || null,
      po_number: parsed.po_number || null,
      customer_name: parsed.customer_name || null,
      job_site: parsed.job_site || null,
      rental_subtotal: rentalSubtotal || null,
      fees_total: feesTotal || null,
      tax: parseFloat(parsed.tax) || null,
      total: parseFloat(parsed.total) || null,
      fees: parsed.fees || {},
      equipment: parsed.equipment || [],
      fee_percentage: feePercentage || null,
      confidence: parsed.confidence || null,
      raw_response: parsed || {}
    }).select().single();
    
    console.log("=== INSERT RESULT ===");
    console.log("INSERT DATA:", JSON.stringify(insertData, null, 2));
    console.log("INSERT ERROR:", insertError);
    console.log("INSERT ID:", insertData?.id);
    
    if (insertError || !insertData || !insertData.id) {
      console.log("!!! INSERT FAILED - cannot proceed with market rate processing !!!");
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to insert invoice', 
        details: insertError 
      });
    }
    
    const invoiceId = insertData.id;
    console.log("Invoice ID confirmed:", invoiceId);
    
    let totalMarketSavings = 0;
    const equipmentWithRates = [];
    
    console.log("=== MARKET RATE PROCESSING START ===");
    console.log("Equipment count:", parsed.equipment?.length || 0);
    
    if (parsed.equipment && parsed.equipment.length > 0) {
      for (const item of parsed.equipment) {
        const rentalDays = parseInt(item.rental_days) || 1;
        
        let actualAmount = parseFloat(item.amount) || 0;
        
        if (actualAmount === 0) {
          actualAmount = calculateExpectedAmount(
            item.day_rate,
            item.week_rate,
            item.four_week_rate,
            rentalDays
          );
          console.log("Calculated amount from rates:", actualAmount, "for", item.description);
        }
        
        console.log("Processing item:", item.description, "amount:", actualAmount, "rental_days:", rentalDays);
        
        if (!item.description) {
          console.log("SKIP: No description");
          continue;
        }
        
        if (actualAmount === 0) {
          console.log("SKIP: No amount and couldn't calculate from rates for", item.description);
          continue;
        }
        
        try {
          console.log("Calling classify_equipment for:", item.description);
          const { data: classifyData, error: classifyError } = await supabase.rpc('classify_equipment', {
            p_description: item.description
          });
          
          console.log("classify_equipment result:", JSON.stringify(classifyData));
          console.log("classify_equipment error:", classifyError);
          
          if (classifyData && classifyData.length > 0) {
            const classified = classifyData[0];
            
            console.log("Calling calculate_savings:", classified.equipment_class, classified.equipment_size, actualAmount, rentalDays);
            const { data: savingsData, error: savingsError } = await supabase.rpc('calculate_savings', {
              p_equipment_class: classified.equipment_class,
              p_equipment_size: classified.equipment_size,
              p_actual_amount: actualAmount,
              p_rental_days: rentalDays,
              p_region: 'Cleveland'
            });
            
            console.log("calculate_savings result:", JSON.stringify(savingsData));
            console.log("calculate_savings error:", savingsError);
            
            if (savingsData && savingsData.length > 0) {
              const savings = savingsData[0];
              totalMarketSavings += parseFloat(savings.total_overpaid) || 0;
              
              equipmentWithRates.push({
                ...item,
                calculated_amount: actualAmount,
                equipment_class: classified.equipment_class,
                equipment_size: classified.equipment_size,
                classification_confidence: classified.confidence,
                market_rate_low: savings.market_rate_low,
                market_rate_high: savings.market_rate_high,
                market_rate_avg: savings.market_rate_avg,
                overpaid_per_day: savings.overpaid_per_day,
                total_overpaid: savings.total_overpaid,
                data_source: savings.data_source
              });
              
              const { error: ratesError } = await supabase.from('equipment_rates').insert({
                invoice_id: invoiceId,
                user_id: userId || null,
                equipment_description: item.description,
                equipment_class: classified.equipment_class,
                equipment_size: classified.equipment_size,
                day_rate: item.day_rate || null,
                week_rate: item.week_rate || null,
                four_week_rate: item.four_week_rate || null,
                rental_days: rentalDays,
                vendor_name: parsed.vendor,
                region: 'Cleveland',
                invoice_date: parsed.invoice_date
              });
              console.log("equipment_rates insert error:", ratesError);
            }
          }
        } catch (err) {
          console.log('Error processing equipment item:', err.message);
        }
      }
    }
    
    console.log("=== MARKET RATE PROCESSING COMPLETE ===");
    console.log("totalMarketSavings:", totalMarketSavings);
    console.log("equipmentWithRates count:", equipmentWithRates.length);
    
    console.log("=== UPDATING MARKET_SAVINGS ===");
    console.log("Invoice ID for update:", invoiceId);
    console.log("market_savings value:", totalMarketSavings);
    console.log("equipment_with_rates count:", equipmentWithRates.length);
    
    const { data: updateData, error: updateError } = await supabase
      .from('parsed_invoices')
      .update({
        market_savings: totalMarketSavings,
        equipment_with_rates: equipmentWithRates
      })
      .eq('id', invoiceId)
      .select();
    
    console.log("=== UPDATE RESULT ===");
    console.log("UPDATE DATA:", JSON.stringify(updateData, null, 2));
    console.log("UPDATE ERROR:", updateError);
    console.log("ROWS UPDATED:", updateData?.length || 0);
    
    if (updateError) {
      console.log("!!! UPDATE FAILED !!!");
    } else if (!updateData || updateData.length === 0) {
      console.log("!!! UPDATE RETURNED NO ROWS - something is wrong !!!");
    } else {
      console.log("SUCCESS: market_savings updated to", updateData[0].market_savings);
    }
    
    res.json({ 
      success: true, 
      data: {
        ...parsed,
        id: invoiceId,
        market_savings: totalMarketSavings,
        equipment_with_rates: equipmentWithRates
      }, 
      raw_response: content 
    });
  } catch (error) {
    console.error('Parse error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`ParseAPI running on port ${PORT}`);
});