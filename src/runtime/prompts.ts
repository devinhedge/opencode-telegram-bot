import readline from "node:readline";
import { createInterface } from "node:readline/promises";

export async function askVisible(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

// Like askVisible, but resolves null when input ends (readline closes) before an answer.
export async function askVisibleOrEof(question: string): Promise<string | null> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await new Promise<string | null>((resolve) => {
      rl.once("close", () => resolve(null));
      rl.question(question).then(
        (answer) => resolve(answer.trim()),
        () => resolve(null),
      );
    });
  } finally {
    rl.close();
  }
}

export async function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const maskedRl = rl as readline.Interface & {
      stdoutMuted?: boolean;
      _writeToOutput?: (value: string) => void;
    };

    maskedRl._writeToOutput = (value: string): void => {
      if (maskedRl.stdoutMuted) {
        if (value.includes("\n") || value.includes("\r")) {
          process.stdout.write(value);
          return;
        }

        if (value.length > 0) {
          process.stdout.write("*");
        }
        return;
      }

      process.stdout.write(value);
    };

    maskedRl.stdoutMuted = false;

    rl.question(question, (answer) => {
      maskedRl.stdoutMuted = false;
      process.stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });

    maskedRl.stdoutMuted = true;
  });
}
