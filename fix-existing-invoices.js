require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function fixExistingInvoices() {
  console.log('=== STARTING FIX FOR EXISTING INVOICES ===\n');

  // Get all invoices that need fixing
  const { data: invoices, error: fetchError } = await supabase
    .from('parsed_invoices')
    .select('*')
    .is('market_savings', null);

  if (fetchError) {
    console.log('ERROR fetching invoices:', fetchError);
    return;
  }

  console.log(`Found ${invoices.length} invoices with NULL market_savings\n`);

  for (const invoice of invoices) {
    console.log(`\n--- Processing Invoice ${invoice.id} ---`);
    console.log(`Vendor: ${invoice.vendor_name}`);
    console.log(`Invoice #: ${invoice.invoice_number}`);

    const equipment = invoice.equipment || [];
    
    if (equipment.length === 0) {
      console.log('No equipment found, setting market_savings to 0');
      await supabase
        .from('parsed_invoices')
        .update({ market_savings: 0, equipment_with_rates: [] })
        .eq('id', invoice.id);
      continue;
    }

    let totalMarketSavings = 0;
    const equipmentWithRates = [];

    for (const item of equipment) {
      if (!item.description) {
        console.log('  SKIP: No description');
        continue;
      }

      // Calculate amount from item
      let actualAmount = parseFloat(item.amount) || 0;
      const rentalDays = parseInt(item.rental_days) || 1;

      if (actualAmount === 0) {
        // Try to calculate from rates
        const day = parseFloat(item.day_rate) || 0;
        const week = parseFloat(item.week_rate) || 0;
        const month = parseFloat(item.four_week_rate) || 0;

        if (day > 0) actualAmount = day * rentalDays;
        else if (week > 0) actualAmount = week * Math.ceil(rentalDays / 7);
        else if (month > 0) actualAmount = month * Math.ceil(rentalDays / 28);
      }

      if (actualAmount === 0) {
        console.log(`  SKIP: ${item.description} - no amount`);
        continue;
      }

      console.log(`  Processing: ${item.description}`);
      console.log(`    Amount: $${actualAmount}, Days: ${rentalDays}`);

      try {
        // Classify equipment
        const { data: classifyData, error: classifyError } = await supabase.rpc('classify_equipment', {
          p_description: item.description
        });

        if (classifyError || !classifyData || classifyData.length === 0) {
          console.log(`    Could not classify: ${classifyError?.message || 'no match'}`);
          continue;
        }

        const classified = classifyData[0];
        console.log(`    Classified as: ${classified.equipment_class} (${classified.equipment_size})`);

        // Calculate savings
        const { data: savingsData, error: savingsError } = await supabase.rpc('calculate_savings', {
          p_equipment_class: classified.equipment_class,
          p_equipment_size: classified.equipment_size,
          p_actual_amount: actualAmount,
          p_rental_days: rentalDays,
          p_region: 'Cleveland'
        });

        if (savingsError || !savingsData || savingsData.length === 0) {
          console.log(`    Could not calculate savings: ${savingsError?.message || 'no data'}`);
          continue;
        }

        const savings = savingsData[0];
        const overpaid = parseFloat(savings.total_overpaid) || 0;
        totalMarketSavings += overpaid;

        console.log(`    Market avg: $${savings.market_rate_avg}/day`);
        console.log(`    Overpaid: $${overpaid}`);

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

      } catch (err) {
        console.log(`    Error: ${err.message}`);
      }
    }

    // Update the invoice
    console.log(`\n  TOTAL SAVINGS: $${totalMarketSavings}`);
    
    const { error: updateError } = await supabase
      .from('parsed_invoices')
      .update({
        market_savings: totalMarketSavings,
        equipment_with_rates: equipmentWithRates
      })
      .eq('id', invoice.id);

    if (updateError) {
      console.log(`  UPDATE FAILED: ${updateError.message}`);
    } else {
      console.log(`  ✓ Updated successfully!`);
    }
  }

  console.log('\n=== DONE ===');
}

fixExistingInvoices();