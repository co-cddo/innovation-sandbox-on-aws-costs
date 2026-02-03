#!/usr/bin/env node
import { Command } from "commander";
import { getCostData } from "./lib/cost-explorer.js";
import { generateMarkdownReport } from "./report-generator.js";

const AWS_PROFILE = "NDX/orgManagement";

const program = new Command();

program
  .name("aws-costs")
  .description("Generate AWS billing reports from Cost Explorer")
  .version("1.0.0")
  .requiredOption("--accountId <id>", "AWS Account ID to query")
  .requiredOption(
    "--startTime <date>",
    "Start date in YYYY-MM-DD format (inclusive)"
  )
  .requiredOption(
    "--endTime <date>",
    "End date in YYYY-MM-DD format (exclusive)"
  )
  .action(async (options) => {
    try {
      // Validate date format
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(options.startTime)) {
        throw new Error(
          `Invalid startTime format: ${options.startTime}. Use YYYY-MM-DD`
        );
      }
      if (!dateRegex.test(options.endTime)) {
        throw new Error(
          `Invalid endTime format: ${options.endTime}. Use YYYY-MM-DD`
        );
      }

      // Validate account ID (12 digits)
      if (!/^\d{12}$/.test(options.accountId)) {
        throw new Error(
          `Invalid accountId: ${options.accountId}. Must be 12 digits`
        );
      }

      const costReport = await getCostData(
        {
          accountId: options.accountId,
          startTime: options.startTime,
          endTime: options.endTime,
        },
        { profile: AWS_PROFILE }
      );

      const markdown = generateMarkdownReport(costReport);
      console.log(markdown);
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
      } else {
        console.error("An unexpected error occurred");
      }
      process.exit(1);
    }
  });

program.parse();
