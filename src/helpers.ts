export function extractLastJSON(input: string): string | null {
    let bracketsCount = 0;
    let lastIndex = -1;
    let firstIndex = -1;

    for (let i = input.length - 1; i >= 0; i--) {
        if (input[i] === '}') {
            if (lastIndex === -1) {
                lastIndex = i;
            }
            bracketsCount++;
        } else if (input[i] === '{') {
            bracketsCount--;
            if (bracketsCount === 0) {
                firstIndex = i;
                break;
            }
        }
    }

    if (firstIndex !== -1 && lastIndex !== -1) {
        return input.substring(firstIndex, lastIndex + 1);
    }

    return null;
}
