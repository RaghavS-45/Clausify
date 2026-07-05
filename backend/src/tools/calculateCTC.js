import { DynamicTool } from "@langchain/core/tools";

export const calculateCTCTool = new DynamicTool({
    name: "calculate_ctc_breakdown",
    description: "Calculate monthly in-hand salary from CTC. Input JSON: { ctc_annual, variable_percent, pf_included }",
    func: async (input) => {
        try {
            const { ctc_annual, variable_percent = 0, pf_included = true } = JSON.parse(input);
            const fixed_annual = ctc_annual * (1 - variable_percent / 100);
            const variable_annual = ctc_annual * (variable_percent / 100);
            const pf_deduction = pf_included ? Math.min(fixed_annual * 0.12, 21600) : 0;
            const monthly_inhand = Math.round((fixed_annual - pf_deduction) / 12);

            return JSON.stringify({
                annual_ctc: ctc_annual,
                fixed_annual: Math.round(fixed_annual),
                variable_annual: Math.round(variable_annual),
                pf_annual: Math.round(pf_deduction),
                monthly_inhand,
                note: variable_percent > 25
                    ? "Warning: high variable component — actual take-home depends on performance targets"
                    : "Take-home estimate is reasonably reliable"
            });
        } catch {
            return "Could not calculate CTC — compensation figures not found in document.";
        }
    }
});