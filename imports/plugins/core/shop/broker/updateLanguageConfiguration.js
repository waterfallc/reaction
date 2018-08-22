import kafka from "kafka-node";
import { Reaction } from "/lib/api";
import ReactionError from "@reactioncommerce/reaction-error";

const { Producer } = kafka;


export default function updateLanguageConfiguration(language, enabled) {

  // must have core permissions
  if (!Reaction.hasPermission("core")) {
    throw new ReactionError("access-denied", "Access Denied");
  }

  const client = new kafka.KafkaClient({ kafkaHost: "127.0.0.1" });
  const producer = new Producer(client);

  const payload = {
    topic: "shopsUpdate",
    messages: {
      updateType: "updateLanguageConfiguration",
      updateData: {
        language,
        enabled
      }
    }
  };

  const payloads = [payload];

  producer.on("ready", () => {
    producer.send(payloads, (err, data) => {
      console.log(data);
    });
  });

  producer.on("error", (err) => {
    console.log("error", err);
  });

}
