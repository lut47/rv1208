export const resolveAfter = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

export const logWithTime = (message: string) =>
    console.log(new Date(), message);
