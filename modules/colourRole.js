import { SlashCommandBuilder } from "discord.js";

const COLOUR_COMMAND_NAME = "colourrole";
const ROLE_PREFIX = "colour:";

// 24 common colour names mapped to Discord role colour values.
const COMMON_COLOURS = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  lime: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  aqua: "#00ffff",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  maroon: "#800000",
  olive: "#808000",
  green: "#008000",
  purple: "#800080",
  teal: "#008080",
  navy: "#000080",
  orange: "#ffa500",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  gold: "#ffd700",
  indigo: "#4b0082"
};

export const colourRoleCommand = new SlashCommandBuilder()
  .setName(COLOUR_COMMAND_NAME)
  .setDescription("Pick a personal colour role")
  .addStringOption(opt =>
    opt
      .setName("colour")
      .setDescription("A common colour name (e.g. blue) or a hex value (#1a2b3c)")
      .setRequired(true)
  );

function parseColourInput(rawInput) {
  const input = rawInput.trim().toLowerCase();

  if (COMMON_COLOURS[input]) {
    return {
      hex: COMMON_COLOURS[input],
      label: input
    };
  }

  const hexMatch = input.match(/^#?([0-9a-f]{6})$/i);
  if (!hexMatch) {
    return null;
  }

  return {
    hex: `#${hexMatch[1].toLowerCase()}`,
    label: `#${hexMatch[1].toLowerCase()}`
  };
}

function roleNameForHex(hex) {
  return `${ROLE_PREFIX}${hex.slice(1).toLowerCase()}`;
}

async function removeExistingColourRoles(member) {
  const colourRoles = member.roles.cache.filter(role =>
    role.name.startsWith(ROLE_PREFIX)
  );

  if (colourRoles.size === 0) return;

  await member.roles.remove(colourRoles);
}

export async function handleColourRoleInteraction(interaction) {
  const rawColour = interaction.options.getString("colour", true);
  const parsed = parseColourInput(rawColour);

  if (!parsed) {
    await interaction.reply({
      content:
        "Invalid colour. Use one of the common colour names or a 6-digit hex value like #1a2b3c.",
      ephemeral: true
    });
    return;
  }

  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "Could not update your role in this context.",
      ephemeral: true
    });
    return;
  }

  try {
    const member = await guild.members.fetch(interaction.user.id);
    const roles = await guild.roles.fetch();

    const roleName = roleNameForHex(parsed.hex);
    let role = roles.find(r => r.name === roleName);

    if (!role) {
      role = await guild.roles.create({
        name: roleName,
        color: parsed.hex,
        permissions: [],
        mentionable: false,
        hoist: false,
        reason: "Self-serve colour role"
      });
    }

    await removeExistingColourRoles(member);
    await member.roles.add(role);

    await interaction.reply({
      content: `Your colour role is now ${parsed.label} (${parsed.hex}).`,
      ephemeral: true
    });
  } catch (error) {
    console.error("Failed to assign colour role:", error);

    await interaction.reply({
      content:
        "I could not set your colour role. Please make sure the bot has Manage Roles and that its role is above colour roles.",
      ephemeral: true
    });
  }
}
