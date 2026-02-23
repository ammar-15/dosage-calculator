# Dosage Calculator

## What this project does

Dosage Calculator is a clinical drug dosage calculation tool.

It takes:

- Patient age
- Weight
- Gender
- Last medication name
- Last dose amount
- Last dose time
- Indication

It calculates:

- The appropriate next dose
- The correct timing for the next dose

This is a demo project for technical and educational purposes. It is not clinical advice.

## Why I built this

This project has been built in collaboration with my wife, Syeda Arfaa, who is a medical doctor.

In daily hospital practice, doctors must manually review Health Canada Product Monographs (PMs) and hospital/clinical dosing guidelines to determine patient-specific dosages.

This process is repetitive and time-consuming, especially in busy settings where quick and accurate prescribing decisions are critical.

The goal was to combine structured clinical reasoning with a clean software system. She helped validate dosing logic and ensure calculations follow real medical practice.


## Data Source

The calculator uses a custom drug data API I built.

The API contains:

- All drugs listed in the Canadian Drug Product Database (DPD)
- Product monograph details
- Indication-specific dosing
- Standard dosing guidelines
- Weight-based dosing rules
- Maximum dose limits
- Dose interval guidance

This allows the calculator to dynamically pull official dosing data instead of hardcoding values.

## How dosing is calculated

The calculation engine:

- Pulls the drug record from the DPD-based API
- Reads dosing guidance from the product monograph
- Applies Indication-specific adjustments based on patient details
- Validates last dose timing
- Returns one direct next-dose recommendation

All logic follows official product monographs as the primary reference source.

## Tech Stack

**Frontend:**

- React Native (Expo)
- Supabase (auth and backend)

**Backend:**

- Node.js
- Custom DPD drug database API
- OpenAI (controlled reasoning layer)
- JSON-based dosing rules

## What the system can be used for

- Drug dose validation demos
- Clinical reasoning simulation
- Hackathon medical AI projects
- Educational tools
- Safe medication timing logic prototypes

## Future Updates

- Dose history tracking
- Multi-drug validation

## Disclaimer

*This is a demonstration tool.*
It is not intended for real-world medical decision making....yet :))
