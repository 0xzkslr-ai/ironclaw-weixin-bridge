export async function* parseSseStream(readable) {
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines = [];

  for await (const chunk of readable) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line === "") {
        if (dataLines.length > 0) {
          yield {
            event: eventName,
            data: dataLines.join("\n"),
          };
        }
        eventName = "message";
        dataLines = [];
        continue;
      }

      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }

  if (dataLines.length > 0) {
    yield { event: eventName, data: dataLines.join("\n") };
  }
}
