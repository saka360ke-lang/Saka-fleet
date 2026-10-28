/**
 * Saka Fleet - Fleet Analytics & Conversational Calculation Engine
 */

export async function calculateFuelConsumption({ supabase, vehicleId, plateNumber, targetUnit = 'metric' }) {
  if (!supabase) {
    return { success: false, status: 'ERROR', explanation: 'Database connection unavailable.' };
  }

  let vehicle = null;
  if (vehicleId) {
    const { data } = await supabase.from('vehicles').select('*').eq('id', vehicleId).is('deleted_at', null).maybeSingle();
    vehicle = data;
  } else if (plateNumber) {
    const cleanPlate = plateNumber.replace(/\s+/g, '').toUpperCase();
    const { data } = await supabase.from('vehicles').select('*').is('deleted_at', null);
    if (data && data.length > 0) {
      vehicle = data.find(v => v.plate_number.replace(/\s+/g, '').toUpperCase() === cleanPlate) || null;
    }
  }

  if (!vehicle) {
    return {
      success: false,
      status: 'VEHICLE_NOT_FOUND',
      explanation: `Could not find vehicle "${plateNumber || vehicleId}". Please check the plate number.`
    };
  }

  const plate = vehicle.plate_number;
  const model = vehicle.make_model || 'Vehicle';
  const unit = vehicle.unit_system || targetUnit || 'metric';
  const distLabel = unit === 'imperial' ? 'miles' : 'km';
  const volLabel = unit === 'imperial' ? 'gallons' : 'liters';
  const effLabel = unit === 'imperial' ? 'MPG' : 'km/L';

  const { data: logs } = await supabase
    .from('expense_logs')
    .select('*')
    .eq('vehicle_id', vehicle.id)
    .ilike('expense_type', '%fuel%')
    .order('created_at', { ascending: false })
    .limit(20);

  let fuelLogs = logs || [];
  if (fuelLogs.length === 0) {
    const { data: legacyLogs } = await supabase
      .from('expenses')
      .select('*')
      .eq('plate', plate)
      .ilike('expense_type', '%fuel%')
      .order('created_at', { ascending: false })
      .limit(20);
    
    if (legacyLogs && legacyLogs.length > 0) {
      fuelLogs = legacyLogs.map(l => ({
        id: l.id,
        vehicle_id: vehicle.id,
        expense_type: l.expense_type,
        amount: Number(l.amount) || 0,
        fuel_liters: Number(l.liters) || 0,
        odometer_reading: l.odometer_reading || null,
        created_at: l.created_at
      }));
    }
  }

  if (fuelLogs.length === 0) {
    return {
      success: true,
      status: 'NO_DATA',
      vehicle: { id: vehicle.id, plate_number: plate, make_model: model },
      explanation: `📊 *Fuel Analysis for ${plate} (${model})*\n\nNo fuel receipts or logs found for this vehicle yet.\n\n💡 *To get started:* Reply with a fuel log like:\n👉 *"Logged ${unit === 'imperial' ? '12 gallons' : '45L'} fuel at ${unit === 'imperial' ? '45000 miles' : '368000 km'} for [amount]"*`
    };
  }

  const chronological = [...fuelLogs].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const validIntervals = [];
  let totalCost = 0;

  for (let i = 0; i < chronological.length; i++) {
    const cur = chronological[i];
    const liters = Number(cur.fuel_liters) || 0;
    const amount = Number(cur.amount) || 0;
    const odo = Number(cur.odometer_reading) || null;
    totalCost += amount;

    if (i > 0) {
      const prev = chronological[i - 1];
      const prevOdo = Number(prev.odometer_reading) || null;
      if (odo && prevOdo && odo > prevOdo && liters > 0) {
        const deltaDist = odo - prevOdo;
        const kmL = deltaDist / liters;
        validIntervals.push({ deltaDist, liters, kmL, date: cur.created_at });
      }
    }
  }

  if (validIntervals.length > 0) {
    const totalDist = validIntervals.reduce((sum, int) => sum + int.deltaDist, 0);
    const totalLiters = validIntervals.reduce((sum, int) => sum + int.liters, 0);
    const avgKmL = (totalDist / totalLiters).toFixed(2);
    const lPer100 = ((totalLiters / totalDist) * 100).toFixed(2);
    const mpg = (avgKmL * 2.35215).toFixed(2);

    const latestInterval = validIntervals[validIntervals.length - 1];
    const latestKmL = latestInterval.kmL.toFixed(2);

    const rating = avgKmL >= 14 ? 'Excellent 🟢' : avgKmL >= 10 ? 'Good 🟡' : 'Heavy Consumption 🔴';
    const effStr = unit === 'imperial' ? `${mpg} MPG` : `${avgKmL} km/L (${lPer100} L/100km)`;
    const latestStr = unit === 'imperial' ? `${(latestKmL * 2.35215).toFixed(2)} MPG` : `${latestKmL} km/L`;

    return {
      success: true,
      status: 'CALCULATED',
      vehicle: { id: vehicle.id, plate_number: plate, make_model: model },
      metrics: { kmPerLiter: Number(avgKmL), litersPer100km: Number(lPer100), mpg: Number(mpg), totalDist, totalLiters, totalCost },
      explanation: `📊 *Fuel Efficiency: ${plate} (${model})*\n\n` +
        `• *Average Consumption:* *${effStr}*\n` +
        `• *Latest Fill-up Rate:* *${latestStr}*\n` +
        `• *Performance Rating:* ${rating}\n` +
        `• *Distance Analyzed:* ${totalDist.toLocaleString()} ${distLabel}\n` +
        `• *Fuel Consumed:* ${totalLiters.toFixed(1)} ${volLabel}\n` +
        `• *Total Fuel Spend:* KES ${totalCost.toLocaleString()}`
    };
  }

  const latestLog = chronological[chronological.length - 1];
  const lastOdo = latestLog.odometer_reading || vehicle.current_mileage || vehicle.odometer_reading;
  const lastLiters = Number(latestLog.fuel_liters) || 0;
  const lastAmt = Number(latestLog.amount) || 0;

  return {
    success: true,
    status: 'NEEDS_MORE_DATA',
    vehicle: { id: vehicle.id, plate_number: plate, make_model: model },
    missingFields: !lastOdo ? ['odometer'] : ['fuel_liters'],
    explanation: `📊 *Fuel Analysis for ${plate} (${model})*\n\n` +
      `Found ${fuelLogs.length} fuel entry (${lastAmt > 0 ? `KES ${lastAmt.toLocaleString()}` : ''}${lastLiters > 0 ? `, ${lastLiters} ${unit === 'imperial' ? 'gal' : 'L'}` : ''}).\n\n` +
      `🔍 *Calculation Rule:* (Distance traveled ÷ ${volLabel}).\n` +
      `To calculate exact ${effLabel}, please share your latest fill-up with odometer and ${volLabel}:\n👉 *"Logged [${volLabel}] at [Odometer] ${distLabel}"*`
  };
}


/**
 * Get Comprehensive Vehicle Financial & Health Summary
 */
export async function getVehicleSummaryReport({ supabase, vehicleId, plateNumber }) {
  if (!supabase) return { success: false, explanation: 'Database unavailable' };

  let vehicle = null;
  if (vehicleId) {
    const { data } = await supabase.from('vehicles').select('*').eq('id', vehicleId).is('deleted_at', null).maybeSingle();
    vehicle = data;
  } else if (plateNumber) {
    const cleanPlate = plateNumber.replace(/\s+/g, '').toUpperCase();
    const { data } = await supabase.from('vehicles').select('*').is('deleted_at', null);
    if (data) vehicle = data.find(v => v.plate_number.replace(/\s+/g, '').toUpperCase() === cleanPlate) || null;
  }

  if (!vehicle) {
    return { success: false, explanation: `Vehicle not found.` };
  }

  const { data: expenses } = await supabase
    .from('expense_logs')
    .select('*')
    .eq('vehicle_id', vehicle.id)
    .order('created_at', { ascending: false });

  let fuelTotal = 0;
  let maintenanceTotal = 0;
  let otherTotal = 0;

  if (expenses && expenses.length > 0) {
    for (const exp of expenses) {
      const amt = Number(exp.amount) || 0;
      const type = (exp.expense_type || '').toLowerCase();
      if (type.includes('fuel')) fuelTotal += amt;
      else if (type.includes('repair') || type.includes('service') || type.includes('maintenance')) maintenanceTotal += amt;
      else otherTotal += amt;
    }
  }

  const { data: earnings } = await supabase
    .from('private_earnings')
    .select('revenue_amount')
    .eq('vehicle_id', vehicle.id);

  const totalEarnings = (earnings || []).reduce((sum, e) => sum + (Number(e.revenue_amount) || 0), 0);

  const { data: reminders } = await supabase
    .from('reminders')
    .select('*')
    .eq('vehicle_id', vehicle.id)
    .eq('status', 'ACTIVE');

  const currOdo = vehicle.current_mileage || vehicle.odometer_reading || 0;
  const unit = vehicle.unit_system === 'imperial' ? 'mi' : 'km';

  return {
    success: true,
    vehicle: {
      id: vehicle.id,
      plate_number: vehicle.plate_number,
      make_model: vehicle.make_model,
      vin: vehicle.vin,
      fuel_type: vehicle.fuel_type,
      odometer: currOdo
    },
    financials: {
      totalFuel: fuelTotal,
      totalMaintenance: maintenanceTotal,
      totalOther: otherTotal,
      totalExpenses: fuelTotal + maintenanceTotal + otherTotal,
      totalEarnings,
      netProfit: totalEarnings - (fuelTotal + maintenanceTotal + otherTotal)
    },
    remindersCount: (reminders || []).length,
    explanation: `📋 *Fleet Status: ${vehicle.plate_number}*\n` +
      `• *Vehicle:* ${vehicle.make_model || 'Vehicle'} (${vehicle.fuel_type || 'Fuel'})\n` +
      `• *Odometer:* ${currOdo.toLocaleString()} ${unit}\n` +
      `• *VIN:* ${vehicle.vin || 'N/A'}\n\n` +
      `💰 *Financials:*\n` +
      `• Fuel Expenses: KES ${fuelTotal.toLocaleString()}\n` +
      `• Repairs/Maintenance: KES ${maintenanceTotal.toLocaleString()}\n` +
      `• Total Spent: KES ${(fuelTotal + maintenanceTotal + otherTotal).toLocaleString()}\n` +
      `• Recorded Revenue: KES ${totalEarnings.toLocaleString()}\n\n` +
      `🔔 *Active Reminders:* ${(reminders || []).length} scheduled\n` +
      `🛡️ *Insurance Expiry:* ${vehicle.insurance_expiry || 'Not set'}`
  };
}

