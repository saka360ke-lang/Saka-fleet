/**
 * Saka Fleet - Fleet Analytics & Conversational Calculation Engine
 */

import { analyzeFuelEconomy, buildFuelEconomyReply } from './fuelEconomy.js';

export async function calculateFuelConsumption({ supabase, vehicleId, plateNumber, targetUnit = 'metric', currency = null }) {
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

  const { data: logs } = await supabase
    .from('expense_logs')
    .select('*')
    .eq('vehicle_id', vehicle.id)
    .ilike('expense_type', '%fuel%')
    .order('created_at', { ascending: false })
    .limit(50);

  let fuelLogs = logs || [];
  if (fuelLogs.length === 0) {
    const { data: legacyLogs } = await supabase
      .from('expenses')
      .select('*')
      .eq('plate', plate)
      .ilike('expense_type', '%fuel%')
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (legacyLogs && legacyLogs.length > 0) {
      fuelLogs = legacyLogs.map(l => ({
        id: l.id,
        vehicle_id: vehicle.id,
        expense_type: l.expense_type,
        amount: Number(l.amount) || 0,
        fuel_liters: Number(l.liters) || 0,
        odometer_reading: l.odometer_reading || null,
        fill_type: null,
        created_at: l.created_at
      }));
    }
  }

  if (fuelLogs.length === 0) {
    const resolvedCurrency = currency || vehicle.currency || 'KES';
    return {
      success: true,
      status: 'NO_DATA',
      vehicle: { id: vehicle.id, plate_number: plate, make_model: model },
      explanation: buildFuelEconomyReply({
        plate,
        model,
        currency: resolvedCurrency,
        analysis: { status: 'NEEDS_MORE_DATA', unitSystem: unit, currency: resolvedCurrency }
      })
    };
  }

  const resolvedCurrency = currency || vehicle.currency || fuelLogs.find((row) => row.currency)?.currency || 'KES';
  const analysis = analyzeFuelEconomy({
    logs: fuelLogs,
    unitSystem: unit,
    currency: resolvedCurrency
  });

  const metrics = analysis.status === 'CALCULATED'
    ? {
      kmPerLiter: analysis.averageKmPerLiter,
      litersPer100km: analysis.averageLitersPer100km,
      mpg: analysis.averageMpg,
      totalDist: analysis.totalDistanceKm,
      totalLiters: analysis.totalLitres,
      totalCost: analysis.totalSpend,
      latestKmPerLiter: analysis.latest.kmPerLiter,
      segmentCount: analysis.segmentCount,
      costPerKm: analysis.costPerKm
    }
    : analysis.status === 'ESTIMATED'
      ? {
        kmPerLiter: analysis.estimate.kmPerLiter,
        litersPer100km: analysis.estimate.litersPer100km,
        mpg: analysis.estimate.mpg,
        totalDist: analysis.estimate.distanceKm,
        totalLiters: analysis.estimate.litres,
        totalCost: analysis.totalSpend,
        segmentCount: 0
      }
      : {};

  return {
    success: true,
    status: analysis.status,
    confidence: analysis.confidence,
    vehicle: { id: vehicle.id, plate_number: plate, make_model: model },
    metrics,
    segments: analysis.segments,
    latest: analysis.latest,
    currentTank: analysis.currentTank,
    warnings: analysis.warnings,
    explanation: buildFuelEconomyReply({ plate, model, analysis, currency: resolvedCurrency })
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

