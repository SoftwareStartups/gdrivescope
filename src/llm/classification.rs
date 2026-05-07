//! Document-classification enum with 11 variants. Unknown values map to
//! `Other` so a provider drift doesn't crash indexing.

use serde::{Deserialize, Serialize};

pub const CLASSIFICATION_VALUES: &[&str] = &[
    "pitch_deck",
    "board_minutes",
    "board_presentation",
    "financial",
    "reporting",
    "newsletter",
    "legal",
    "strategy",
    "hr",
    "research",
    "other",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Classification {
    PitchDeck,
    BoardMinutes,
    BoardPresentation,
    Financial,
    Reporting,
    Newsletter,
    Legal,
    Strategy,
    Hr,
    Research,
    Other,
}

impl Classification {
    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "pitch_deck" => Self::PitchDeck,
            "board_minutes" => Self::BoardMinutes,
            "board_presentation" => Self::BoardPresentation,
            "financial" => Self::Financial,
            "reporting" => Self::Reporting,
            "newsletter" => Self::Newsletter,
            "legal" => Self::Legal,
            "strategy" => Self::Strategy,
            "hr" => Self::Hr,
            "research" => Self::Research,
            // Unknown values map to Other rather than erroring.
            _ => Self::Other,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::PitchDeck => "pitch_deck",
            Self::BoardMinutes => "board_minutes",
            Self::BoardPresentation => "board_presentation",
            Self::Financial => "financial",
            Self::Reporting => "reporting",
            Self::Newsletter => "newsletter",
            Self::Legal => "legal",
            Self::Strategy => "strategy",
            Self::Hr => "hr",
            Self::Research => "research",
            Self::Other => "other",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_falls_back_to_other() {
        assert_eq!(
            Classification::from_str_lossy("nope"),
            Classification::Other
        );
    }

    #[test]
    fn serialization_matches_classification_values_constant() {
        for raw in CLASSIFICATION_VALUES {
            let v = Classification::from_str_lossy(raw);
            let json = serde_json::to_string(&v).unwrap();
            assert_eq!(json, format!("\"{raw}\""));
        }
    }
}
